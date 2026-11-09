import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "@/lib/is-record";

import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";

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
/**
 * Pre-check for an `initialize` request, so other frames are not parsed. In a document's text
 * (didOpen, didChange) the quotes are escaped, so it does not match there.
 */
const INITIALIZE_METHOD = /"method"\s*:\s*"initialize"/;
/** Most `stat` calls a batch runs at once, so a checkout-wide change does not open every file. */
const STAT_CONCURRENCY = 64;

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
  if (!INITIALIZE_METHOD.test(data)) return data;
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
 * The file watchers one language server registered through `client/registerCapability` or its
 * manager declared, and the forwarding of matching worktree changes to it as batched `workspace/didChangeWatchedFiles`
 * notifications.
 */
export class WatchedFilesForwarder {
  private readonly registrations = new Map<string, Watcher[]>();
  /** Absolute path → the WatchKind bits wanted for it, as matched when it was queued. */
  private readonly pending = new Map<string, number>();
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
  /** Paths reported as existing, for file systems that record no birth time. */
  private readonly seen = new Set<string>();
  /** Watchers the manager declared (see {@link declareWatchers}), whatever the server registers. */
  private declared: Watcher[] = [];
  /** The declared watchers that also take events from inside git-ignored directories. */
  private declaredIgnored: Watcher[] = [];
  private initialized = false;

  constructor(
    /** Absolute worktree path; glob strings that are not absolute are matched relative to it. */
    readonly root: string,
    private readonly send: (changes: FileEvent[]) => void,
    private readonly debounceMs = DEBOUNCE_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  /**
   * Add watchers of the manager's own, for servers that register none, all three change kinds.
   * Globs are relative to the worktree. `ignoredGlobs` also take the events inside git-ignored
   * directories that {@link wantsIgnoredPath} asks about. They apply from
   * {@link serverInitialized}; changes before it are held.
   */
  declareWatchers(globs: readonly string[], ignoredGlobs: readonly string[]): void {
    const watcher = (glob: string) => compiled(this.root, glob, WATCH_KIND_ALL);
    this.declaredIgnored = ignoredGlobs.map(watcher);
    this.declared = [...globs.map(watcher), ...this.declaredIgnored];
  }

  /**
   * The client's `initialized` reached the server, which may not get notifications before that.
   * Registered watchers cannot come earlier, so only declared ones wait for this.
   */
  serverInitialized(): void {
    this.initialized = true;
    this.releaseEarly();
  }

  /** Whether a declared watcher wants this worktree-relative, `/`-separated ignored path. */
  wantsIgnoredPath(relPath: string): boolean {
    return this.declaredIgnored.some((watcher) => watcher.glob.match(fold(relPath)));
  }

  /** Record a `workspace/didChangeWatchedFiles` registration's watchers under its id. */
  register(id: string, registerOptions: unknown): void {
    const watchers = isRecord(registerOptions) ? registerOptions.watchers : undefined;
    this.registrations.set(
      id,
      Array.isArray(watchers) ? watchers.flatMap((w) => this.compileWatcher(w) ?? []) : [],
    );
    this.releaseEarly();
  }

  /** Queue the changes kept from before the watchers that want them existed. */
  private releaseEarly(): void {
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
   * Queue changed absolute paths. Paths no watcher matches are dropped; while the server has no
   * watcher registered they are kept for later registrations instead.
   */
  queue(paths: Iterable<string>): void {
    if (this.disposed) return;
    const keepEarly = !this.hasWatchers();
    const wasEmpty = this.pending.size === 0;
    for (const p of paths) {
      const kinds = this.kindsFor(p);
      if (kinds !== 0) this.pending.set(p, kinds);
      else if (keepEarly && this.early.size < EARLY_LIMIT) this.early.add(p);
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
    this.seen.clear();
    this.registrations.clear();
  }

  /** WatchKind bits wanted for this absolute path across every watcher; 0 = none. */
  kindsFor(absPath: string): number {
    let kinds = 0;
    const declared = this.initialized ? this.declared : [];
    for (const watchers of [declared, ...this.registrations.values()]) {
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
    const batch = [...this.pending];
    this.pending.clear();
    const changes: FileEvent[] = [];
    for (let i = 0; i < batch.length; i += STAT_CONCURRENCY) {
      const events = await Promise.all(
        batch.slice(i, i + STAT_CONCURRENCY).map(async ([absPath, kinds]) => {
          const type = await this.changeTypeOf(absPath);
          // A path judged created may be one the server already read (an atomic save, a checkout,
          // a reinstalled package). TypeScript ignores a creation of a file it has loaded but needs
          // it for a new root file, so a creation is reported as a change first; in the other order
          // TypeScript keeps the old contents.
          const types =
            type === FileChangeType.Created
              ? [FileChangeType.Changed, FileChangeType.Created]
              : [type];
          const uri = fileUri(absPath);
          return types.filter((t) => kinds & WATCH_KIND_BIT[t]).map((t) => ({ uri, type: t }));
        }),
      );
      for (const fileEvents of events) changes.push(...fileEvents);
    }
    if (this.disposed || changes.length === 0) return;
    this.send(changes);
  }

  /** What happened to a path the watcher reported, judged from what is on disk now. */
  private async changeTypeOf(absPath: string): Promise<FileChangeTypeValue> {
    let stats: Stats;
    try {
      stats = await stat(absPath);
    } catch (err) {
      const code = isRecord(err) ? err.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return FileChangeType.Changed;
      this.seen.delete(absPath);
      return FileChangeType.Deleted;
    }
    // Only needed where the file system records no birth time.
    if (stats.birthtimeMs !== 0) return existingFileChangeType(stats, false);
    const seenBefore = this.seen.has(absPath);
    this.seen.add(absPath);
    return existingFileChangeType(stats, seenBefore);
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
    try {
      return compiled(fileURLToPath(baseUri), globPattern.pattern, kind);
    } catch {
      // A `file://host/...` URI has no local path, and this runs inside the stdout read loop.
      return null;
    }
  }
}

/**
 * Whether an existing file reported by the watcher was created or changed (see
 * {@link CREATED_WINDOW_MS}). Where the file system records no birth time (Linux, mostly), a file
 * is created the first time this forwarder sees it, unless it was moved into place.
 */
export function existingFileChangeType(
  stats: Pick<Stats, "birthtimeMs" | "mtimeMs" | "ctimeMs">,
  seenBefore: boolean,
): FileChangeTypeValue {
  const isNew =
    stats.birthtimeMs === 0 ? !seenBefore : stats.mtimeMs - stats.birthtimeMs < CREATED_WINDOW_MS;
  const movedIntoPlace = stats.ctimeMs - stats.mtimeMs > CREATED_WINDOW_MS;
  return isNew || movedIntoPlace ? FileChangeType.Created : FileChangeType.Changed;
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
