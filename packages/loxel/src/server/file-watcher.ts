import { realpathSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import { logger } from "./logger";
import { stress } from "./stress-detector";

const log = logger.child("watcher");

export type WatchEvent = "status" | "refs" | "log" | "worktrees";

export interface FileWatcherOptions {
  gitRoot: string;
  onEvent: (event: WatchEvent) => void;
  debounceMs?: number;
  /** If set, only emit these event types (filters out the rest). */
  allowedEvents?: Set<WatchEvent>;
}

/**
 * Resolve the actual git directories to watch.
 *
 * In a regular repo: --git-dir and --git-common-dir both resolve to `.git/`.
 * In a worktree: --git-dir is the worktree-specific dir (HEAD, index),
 * --git-common-dir is the shared dir (objects, refs/heads, refs/tags).
 * We need to watch both for full coverage.
 */
async function resolveGitDirs(gitRoot: string): Promise<{ gitDir: string; commonDir: string }> {
  const [gitDirRaw, commonDirRaw] = await Promise.all([
    Bun.$`git -C ${gitRoot} rev-parse --git-dir`.text(),
    Bun.$`git -C ${gitRoot} rev-parse --git-common-dir`.text(),
  ]);

  const resolve = (raw: string) => {
    const trimmed = raw.trim();
    const absolute = trimmed.startsWith("/") ? trimmed : path.join(gitRoot, trimmed);
    return realpathSync(absolute);
  };

  return { gitDir: resolve(gitDirRaw), commonDir: resolve(commonDirRaw) };
}

/**
 * Map a filename reported by the git-directory watch onto the refreshes it should trigger.
 *
 * Two properties of this function are load-bearing and must survive any cleanup.
 *
 * **A trailing `.lock` is stripped, not ignored.** Git writes nearly everything as `X.lock`
 * followed by a rename to `X`, and macOS FSEvents coalesces the write burst inside a directory
 * and surfaces only a nondeterministic *subset* of the changed filenames. In practice the lock
 * name is frequently the only one reported: `git tag` surfaces just `refs/tags/v9.lock`, and
 * `git checkout` just `index.lock` + `AUTO_MERGE.lock`. Ignoring locks — as this function used
 * to — therefore meant classifying every common git operation as "nothing happened". A
 * `X.lock` event *is* the "X is being written" signal, and the caller's debounce collapses the
 * lock and final-name events into one refresh when both do arrive.
 *
 * The obvious hazard is a feedback loop: a read-only `git status` refreshes the index and
 * writes `index.lock` too, so treating that as a status signal would make the watcher feed
 * itself. That is handled at the source instead — every read-only git command Loxel runs sets
 * `GIT_OPTIONAL_LOCKS=0` (see `git-commands/git-env.ts`) and writes nothing in the git dir.
 *
 * **Every rule is anchored at the start of the path, and unknown paths return `[]`.** For a
 * bare repo the git dir, the common dir and the repo root are all the same directory, and the
 * working trees live at `<repo>/.worktrees/` — *inside* the recursively watched tree. A
 * catch-all or an unanchored `endsWith`/`includes` rule would fire on every source-file save
 * and every `node_modules` write in every worktree. Anchoring is what makes
 * `.worktrees/foo/src/a.ts` and `.worktrees/foo/objects/x` fall through to `[]`.
 *
 * The same anchoring gives the per-worktree split for free: a linked worktree gets its own
 * FileWatcher whose `gitDir` *is* `<common>/worktrees/<name>/`, so that worktree's `index`,
 * `HEAD` and `logs/HEAD` arrive start-anchored and classify normally there — while the same
 * files seen through the parent's common-dir watch arrive as `worktrees/<name>/index` and are
 * correctly ignored.
 */
export function classifyGitChange(filename: string): WatchEvent[] {
  const file = filename.endsWith(".lock") ? filename.slice(0, -".lock".length) : filename;

  const events: WatchEvent[] = [];

  if (file === "index") {
    events.push("status");
  }

  if (file === "HEAD" || file === "ORIG_HEAD") {
    events.push("refs", "log");
  }

  // FETCH_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD — in-progress operation state. The `includes("/")`
  // guard keeps this anchored to the git dir root so a worktree's own MERGE_HEAD, or a source
  // file named `FOO_HEAD`, does not match.
  if (file !== "HEAD" && file.endsWith("_HEAD") && !file.includes("/")) {
    events.push("status", "refs");
  }

  // Written by checkout/merge to record the merged-tree state; its presence changes what
  // `git status` reports.
  if (file === "AUTO_MERGE") {
    events.push("status");
  }

  if (file === "packed-refs") {
    events.push("refs");
  }

  if (file.startsWith("refs/heads/") || file.startsWith("refs/tags/")) {
    events.push("refs", "log");
  }

  if (file.startsWith("refs/remotes/")) {
    events.push("refs");
  }

  if (file === "refs/stash" || file.startsWith("logs/refs/stash")) {
    events.push("status");
  }

  if (file === "logs/HEAD") {
    events.push("refs", "log");
  }

  if (file.startsWith("logs/refs/heads/") || file.startsWith("logs/refs/tags/")) {
    events.push("refs", "log");
  }

  if (file.startsWith("logs/refs/remotes/")) {
    events.push("refs");
  }

  // A commit sometimes surfaces *only* loose-object writes — FSEvents drops the ref and index
  // names entirely — so `objects/` has to count as evidence that something happened, and we
  // cannot tell which kind of something from the path. Mapping it to all three refreshes
  // over-fires a little (staging writes objects too), which is the correct trade: the debounce
  // bounds the cost, every handler is a read-only git query, and three refreshes on real git
  // activity beats zero. Do not narrow this.
  if (file.startsWith("objects/")) {
    events.push("status", "refs", "log");
  }

  // Worktree lifecycle. `gitdir` and `commondir` are both written exactly once, when
  // `git worktree add` creates `worktrees/<name>/`, and never touched again — so they are
  // safe to treat as lifecycle signals. Per-worktree `HEAD`/`index`/`logs/` churn on every
  // commit, checkout and staging operation and must NOT map to `worktrees`.
  //
  // Both names are matched because macOS FSEvents coalesces the creation burst and surfaces
  // only a subset of the new directory's entries: in practice `commondir` is the one reported
  // and `gitdir` almost never is. Removal surfaces nothing usable here at all, which is why
  // FileWatcher additionally watches the `worktrees/` directory itself (see start()).
  if (file.startsWith("worktrees/")) {
    const segments = file.split("/");
    const base = segments[3] === undefined ? segments[2] : undefined;
    if (base === "gitdir" || base === "commondir") {
      events.push("worktrees");
    }
  }

  return events;
}

/**
 * Watch the git directory (and common dir for worktrees) for changes and emit events.
 *
 * Uses Node's native fs.watch with `{ recursive: true }` which leverages macOS FSEvents
 * for zero-overhead recursive watching (no initial directory scan).
 *
 * Worktree add/remove needs a second, non-recursive watch on `<commonDir>/worktrees`:
 * FSEvents coalesces the writes inside a per-worktree directory and drops most filenames,
 * so removal is invisible to the recursive watch. Directory-entry create/delete is always
 * reported to a watch on the parent directory, and file churn inside the subdirectories is
 * invisible to it — exactly the lifecycle signal with none of the noise.
 */
export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private worktreesDirWatcher: FSWatcher | null = null;
  private commonDir: string | null = null;
  private gitRoot: string;
  private onEvent: (event: WatchEvent) => void;
  private debounceMs: number;
  private allowedEvents: Set<WatchEvent> | null;
  private debounceTimers: Map<WatchEvent, ReturnType<typeof setTimeout>> = new Map();

  constructor(options: FileWatcherOptions) {
    this.gitRoot = options.gitRoot;
    this.onEvent = options.onEvent;
    this.debounceMs = options.debounceMs ?? 100;
    this.allowedEvents = options.allowedEvents ?? null;
  }

  async start() {
    if (this.watchers.length > 0) return;

    const { gitDir, commonDir } = await resolveGitDirs(this.gitRoot);

    const handler = (_eventType: string, filename: string | null) => {
      if (!filename) return;
      const events = this.classifyChange(filename);
      for (const event of events) {
        this.emitDebounced(event);
      }
    };

    this.watchers.push(watch(gitDir, { recursive: true }, handler));

    // A status-only per-worktree watcher needs only its own admin dir. Watching
    // the shared common dir once per worktree multiplies every object/ref event.
    if (commonDir !== gitDir && this.acceptsAny("refs", "log", "worktrees")) {
      this.watchers.push(watch(commonDir, { recursive: true }, handler));
    }

    // commonDir, not gitDir: linked worktrees share the common dir, and it is the only one
    // that holds `worktrees/`. For a bare repo commonDir is the repo root, so this resolves
    // to `<repo>/worktrees` (git metadata), not the directory the working trees live in.
    if (this.acceptsAny("worktrees")) {
      this.commonDir = commonDir;
      this.attachWorktreesDirWatcher();
    }
  }

  stop() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.worktreesDirWatcher?.close();
    this.worktreesDirWatcher = null;
    this.commonDir = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private classifyChange(filename: string): WatchEvent[] {
    const events = classifyGitChange(filename);
    // A repo that has never had a worktree has no `worktrees/` directory to watch at start().
    // The recursive watch sees the first one being created, which is our cue to attach.
    if (events.includes("worktrees")) {
      this.attachWorktreesDirWatcher();
    }
    return events;
  }

  /**
   * Attach the non-recursive `<commonDir>/worktrees` watch, if possible.
   *
   * Idempotent and safe to call from the recursive watch handler: a stopped watcher has no
   * commonDir, so a late attach after stop() is a no-op. The directory is absent until the
   * repo's first worktree exists, which is expected rather than an error.
   */
  private attachWorktreesDirWatcher() {
    if (this.worktreesDirWatcher) return;
    if (!this.commonDir) return;

    const dir = path.join(this.commonDir, "worktrees");
    try {
      this.worktreesDirWatcher = watch(dir, { recursive: false }, () => {
        this.emitDebounced("worktrees");
      });
    } catch (error) {
      log.debug("Worktrees directory not watchable yet, relying on git-dir watch", {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitDebounced(event: WatchEvent) {
    if (this.allowedEvents && !this.allowedEvents.has(event)) return;
    stress.track("git-watch", { event });

    const existing = this.debounceTimers.get(event);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(event);
      const desc =
        event === "status"
          ? "Detected index change, refreshing status"
          : event === "refs"
            ? "Detected ref update, refreshing refs"
            : event === "worktrees"
              ? "Detected worktree change, refreshing worktree list"
              : "Detected branch/tag change, refreshing log";
      log.debug(desc);
      this.onEvent(event);
    }, this.debounceMs);

    this.debounceTimers.set(event, timer);
  }

  private acceptsAny(...events: WatchEvent[]): boolean {
    return !this.allowedEvents || events.some((event) => this.allowedEvents!.has(event));
  }
}
