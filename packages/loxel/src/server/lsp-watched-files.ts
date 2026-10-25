import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { logger } from "./logger";

const log = logger.child("server");

/** LSP `FileChangeType`. */
export const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;
export type FileChangeTypeValue = (typeof FileChangeType)[keyof typeof FileChangeType];

/** LSP `FileEvent`, one entry of a `workspace/didChangeWatchedFiles` notification. */
export interface FileEvent {
  uri: string;
  type: FileChangeTypeValue;
}

/** LSP `WatchKind` bit for each change type; a watcher without `kind` wants all three. */
const WATCH_KIND_BIT: Record<FileChangeTypeValue, number> = { 1: 1, 2: 2, 3: 4 };
const WATCH_KIND_ALL = 7;
/** Quiet period before a batch is sent; the file watcher already coalesced its own events. */
const DEBOUNCE_MS = 250;
/**
 * Most changes kept from before the server's watchers were registered. A server reads the disk
 * before it registers its watchers (tsc only once the project has loaded), so changes in between
 * are replayed to every later registration that wants them instead of being lost.
 */
const EARLY_LIMIT = 10_000;
/** Longest a change waits for quiet, so a file written continuously cannot hold back the rest. */
const MAX_WAIT_MS = 1000;
/**
 * A file whose last write came within this long of its creation, or whose last metadata change
 * (a rename or move into place) came this long after its last write, is reported as created. The
 * watcher does not say whether a path is new, and servers differ there: basedpyright re-resolves
 * imports only for created files, so a new module reported as changed would stay unresolved.
 */
const CREATED_WINDOW_MS = 1000;
/** TypeScript registers lowercased paths on case-insensitive file systems. */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";

interface Watcher {
  glob: Bun.Glob;
  /** Directory the glob is matched relative to. */
  base: string;
  /** WatchKind bits. */
  kind: number;
}

/**
 * Add the `workspace.didChangeWatchedFiles` client capability to a client `initialize` request,
 * so servers register their file watchers with us. Relative patterns are not advertised, which
 * keeps servers from asking for most directories outside the workspace; globs that still point
 * outside it are accepted but never match, since only worktree paths are reported. Returns any
 * other frame unchanged.
 */
export function withWatchedFilesCapability(data: string): string {
  if (!data.includes('"initialize"')) return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  if (!isRecord(parsed) || parsed.method !== "initialize" || !isRecord(parsed.params)) return data;
  const capabilities = isRecord(parsed.params.capabilities) ? parsed.params.capabilities : {};
  const workspace = isRecord(capabilities.workspace) ? capabilities.workspace : {};
  workspace.didChangeWatchedFiles = { dynamicRegistration: true };
  capabilities.workspace = workspace;
  parsed.params.capabilities = capabilities;
  return JSON.stringify(parsed);
}

/** A server's `client/registerCapability` or `client/unregisterCapability` request, split. */
export interface WatchedFilesRegistration {
  requestId: number | string;
  register: boolean;
  /** The `workspace/didChangeWatchedFiles` entries. */
  entries: Array<{ id: string; registerOptions?: unknown }>;
  /** The request carrying only the other entries, or null when none are left. */
  remainder: string | null;
}

/**
 * Split a server→client (un)registration request into its `workspace/didChangeWatchedFiles`
 * entries and the rest. Returns null for any other frame and for requests without such entries.
 */
export function splitWatchedFilesRegistration(body: string): WatchedFilesRegistration | null {
  if (!body.includes(WATCHED_FILES_METHOD)) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(msg) || !isRecord(msg.params)) return null;
  const { id: requestId, method } = msg;
  if (typeof requestId !== "number" && typeof requestId !== "string") return null;
  const register = method === "client/registerCapability";
  if (!register && method !== "client/unregisterCapability") return null;
  // `unregisterations` is the LSP spec's spelling.
  const listKey = register ? "registrations" : "unregisterations";
  const list = msg.params[listKey];
  if (!Array.isArray(list)) return null;

  const isWatchedFiles = (entry: unknown): entry is { id: string; registerOptions?: unknown } =>
    isRecord(entry) && entry.method === WATCHED_FILES_METHOD && typeof entry.id === "string";
  const entries = list.filter(isWatchedFiles);
  if (entries.length === 0) return null;
  const rest = list.filter((entry) => !isWatchedFiles(entry));
  const remainder =
    rest.length === 0
      ? null
      : JSON.stringify({ ...msg, params: { ...msg.params, [listKey]: rest } });
  return { requestId, register, entries, remainder };
}

/**
 * The file watchers one language server registered through `client/registerCapability`, and the
 * forwarding of matching worktree changes to it as batched `workspace/didChangeWatchedFiles`
 * notifications.
 */
export class WatchedFilesForwarder {
  private readonly registrations = new Map<string, Watcher[]>();
  private readonly pending = new Set<string>();
  /**
   * Changes queued while no watcher was registered. Each registration takes the ones its watchers
   * want; the rest stay for a later one, since a server may register its watchers in several
   * entries or frames.
   */
  private readonly early = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest pending path was queued; the batch goes out by {@link MAX_WAIT_MS} after. */
  private pendingSince = 0;
  /** Batches are sent in order, each after the previous one's stats finished. */
  private flushing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    /** Absolute worktree path; glob strings that are not absolute are matched relative to it. */
    readonly root: string,
    private readonly send: (changes: FileEvent[]) => void,
    private readonly debounceMs = DEBOUNCE_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  /** Record a `workspace/didChangeWatchedFiles` registration's watchers under its id. */
  register(id: string, registerOptions: unknown): void {
    const watchers = isRecord(registerOptions) ? registerOptions.watchers : undefined;
    this.registrations.set(
      id,
      Array.isArray(watchers) ? watchers.flatMap((w) => this.compileWatcher(w) ?? []) : [],
    );
    const wanted = [...this.early].filter((p) => this.kindsFor(p) !== 0);
    for (const p of wanted) this.early.delete(p);
    this.queue(wanted);
  }

  /** Whether any registration holds a usable watcher (an empty or malformed one does not count). */
  private hasWatchers(): boolean {
    for (const watchers of this.registrations.values()) {
      if (watchers.length > 0) return true;
    }
    return false;
  }

  /** Forget a registration; false when the id is not one of ours. */
  unregister(id: string): boolean {
    return this.registrations.delete(id);
  }

  /**
   * Queue changed absolute paths. Paths no registered watcher matches are dropped; while no watcher
   * is registered they are kept for later registrations instead.
   */
  queue(paths: Iterable<string>): void {
    if (this.disposed) return;
    if (!this.hasWatchers()) {
      for (const p of paths) {
        if (this.early.size >= EARLY_LIMIT) break;
        this.early.add(p);
      }
      return;
    }
    const wasEmpty = this.pending.size === 0;
    for (const p of paths) {
      if (this.kindsFor(p) !== 0) this.pending.add(p);
    }
    if (this.pending.size === 0) return;
    const now = Date.now();
    if (wasEmpty) this.pendingSince = now;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(this.debounceMs, this.pendingSince + this.maxWaitMs - now);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flushing = this.flushing
          .then(() => this.flush())
          .catch((err: unknown) =>
            log.warn("Forwarding watched-file changes failed", { error: err }),
          );
      },
      Math.max(0, delay),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.early.clear();
    this.registrations.clear();
  }

  /** WatchKind bits wanted for this absolute path across every registered watcher; 0 = none. */
  kindsFor(absPath: string): number {
    let kinds = 0;
    for (const watchers of this.registrations.values()) {
      for (const watcher of watchers) {
        if ((kinds & watcher.kind) === watcher.kind) continue;
        const subject = matchSubject(watcher, absPath);
        // oxlint-disable-next-line oxc/bad-bitwise-operator -- WatchKind is a bit set
        if (subject !== null && watcher.glob.match(subject)) kinds |= watcher.kind;
      }
    }
    return kinds;
  }

  private async flush(): Promise<void> {
    const paths = [...this.pending];
    this.pending.clear();
    const events = await Promise.all(
      paths.map(async (absPath): Promise<FileEvent | null> => {
        const kinds = this.kindsFor(absPath);
        if (kinds === 0) return null;
        const type = await changeTypeOf(absPath);
        if (!(kinds & WATCH_KIND_BIT[type])) return null;
        return { uri: pathToFileURL(absPath).href, type };
      }),
    );
    const changes = events.filter((e) => e !== null);
    if (this.disposed || changes.length === 0) return;
    this.send(changes);
  }

  private compileWatcher(raw: unknown): Watcher | null {
    if (!isRecord(raw)) return null;
    const kind = typeof raw.kind === "number" ? raw.kind & WATCH_KIND_ALL : WATCH_KIND_ALL;
    const { globPattern } = raw;
    if (typeof globPattern === "string") {
      const fsRoot = path.parse(globPattern).root;
      if (!fsRoot) return compiled(this.root, globPattern, kind);
      // An absolute glob (TypeScript's) is matched relative to the worktree when it spells out the
      // worktree path, which then must not be read as glob syntax (`[old]`, `{x}`), else from the
      // file system root.
      const rootPrefix = this.root + path.sep;
      if (fold(globPattern).startsWith(fold(rootPrefix))) {
        return compiled(this.root, globPattern.slice(rootPrefix.length), kind);
      }
      return compiled(fsRoot, globPattern.slice(fsRoot.length), kind);
    }
    // RelativePattern: `baseUri` is a URI or a WorkspaceFolder.
    if (!isRecord(globPattern) || typeof globPattern.pattern !== "string") return null;
    const baseUri = isRecord(globPattern.baseUri) ? globPattern.baseUri.uri : globPattern.baseUri;
    if (typeof baseUri !== "string" || !baseUri.startsWith("file:")) return null;
    return compiled(fileURLToPath(baseUri), globPattern.pattern, kind);
  }
}

function compiled(base: string, pattern: string, kind: number): Watcher {
  return { glob: new Bun.Glob(fold(pattern)), base, kind };
}

function fold(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

/** The string a watcher's glob is matched against, or null when the path is outside its base. */
function matchSubject(watcher: Watcher, absPath: string): string | null {
  const relative = path.relative(fold(watcher.base), fold(absPath));
  if (relative === "" || path.isAbsolute(relative)) return null;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative.replaceAll(path.sep, "/");
}

/** What happened to a path the watcher reported, judged from what is on disk now. */
async function changeTypeOf(absPath: string): Promise<FileChangeTypeValue> {
  try {
    const stats = await stat(absPath);
    // A zero birth time means the platform does not record it. Report a creation then: servers
    // refresh at least as much for one as for a change.
    if (
      stats.birthtimeMs === 0 ||
      stats.mtimeMs - stats.birthtimeMs < CREATED_WINDOW_MS ||
      stats.ctimeMs - stats.mtimeMs > CREATED_WINDOW_MS
    ) {
      return FileChangeType.Created;
    }
    return FileChangeType.Changed;
  } catch (err) {
    const code = isRecord(err) ? err.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? FileChangeType.Deleted
      : FileChangeType.Changed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
