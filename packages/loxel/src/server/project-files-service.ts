import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

import { $ } from "bun";

import type { StatusInfo } from "@/api/git-models";
import type { DirEntry, ProjectFileStatus } from "@/api/project-files-model";

import type { FileChange } from "./file-sync-service";
import { FilesSyncService } from "./file-sync-service";
import { getStatus, readOnlyGitEnv } from "./git-commands";
import { logger } from "./logger";

const log = logger.child("files");

/** Work accumulated while a refresh pass is running, applied by the next pass as one unit. */
interface PendingRefresh {
  /** Changed paths (relative, `/`-separated) and every write nonce matched for each. */
  changes: Map<string, string[]>;
  /** Directories whose cached subtree must be dropped first (deleted by a file operation). */
  purgeDirs: Set<string>;
  /**
   * Re-read every cached directory rather than only the parents of changed paths: the change
   * could not be pinned to files (null-filename watcher event), or it came from the git dir
   * (checkout, reset, stash) and may have rewritten files whose events FSEvents dropped.
   */
  rescanAll: boolean;
  waiters: Array<() => void>;
}

/**
 * Manages cached directory contents with git status overlay for a worktree, and owns that
 * worktree's git status snapshot.
 *
 * Composes with {@link FilesSyncService} for fs.watch lifecycle, debouncing,
 * and nonce-tracked writes. Each refresh pass rebuilds git status and updates
 * cached directory entries.
 *
 * Two separate concerns, two separate triggers:
 * - Directory contents (what files exist): updated when the watcher detects
 *   changes in a cached (expanded) directory
 * - Git statuses (what color each entry gets): rebuilt on every pass so
 *   status changes propagate to parent folders even for collapsed directories
 *
 * Passes are coalesced: at most one runs at a time, and everything requested meanwhile — any
 * number of watcher flushes, file operations and git-dir refreshes — is merged into a single
 * follow-up pass, so a burst of events costs at most two passes instead of a queue that grows
 * with the burst. Passes are serialized because they mutate shared state (dirCache, status
 * maps): overlapping passes could make one caller's entriesEqual check see entries written by
 * another instead of the true "old" entries, suppressing onDirChanged broadcasts.
 */
export class ProjectFilesService {
  /** File path → git status (only non-normal files are stored). */
  private fileStatusMap = new Map<string, ProjectFileStatus>();
  /** Directory path → derived status (propagated from children via git status). */
  private dirStatusMap = new Map<string, ProjectFileStatus>();
  /** Ignored directory paths (from git ls-files --ignored --directory). */
  private ignoredDirs = new Set<string>();
  /** Ignored file paths (from git ls-files --ignored --directory). */
  private ignoredFiles = new Set<string>();
  /** Untracked directory paths (from git status, entries like `? dir/`). */
  private untrackedDirs = new Set<string>();
  /** The status the maps were last built from; null until one has been read. */
  private status: StatusInfo | null = null;

  /** Cached readdir results for directories the client has expanded. */
  private dirCache = new Map<string, DirEntry[]>();
  /** In-flight readdir promises to avoid duplicate concurrent reads. */
  private pendingReads = new Map<string, Promise<DirEntry[]>>();

  /** Work for the next pass; null when nothing is queued. */
  private pending: PendingRefresh | null = null;
  /** The drain loop, while one is running. */
  private draining: Promise<void> | null = null;
  private stopped = false;

  private syncService: FilesSyncService;

  constructor(
    private worktreeCwd: string,
    private onDirChanged: (dir: string, entries: DirEntry[]) => void,
    private onFileChanged?: (filePath: string, nonces: string[]) => void,
    /**
     * Called with the fresh status after every pass that read it — working-tree edits and
     * git-dir refreshes alike. Read-only git runs with GIT_OPTIONAL_LOCKS=0 and writes nothing
     * under the git dir, so this is the only signal that an edit changed the status. It must
     * not request another refresh: the snapshot it receives is already current.
     */
    private onStatusChanged?: (status: StatusInfo) => void,
  ) {
    this.syncService = new FilesSyncService({
      watchDir: worktreeCwd,
      recursive: true,
      filter: (filename) => {
        if (filename === ".git" || filename.startsWith(`.git${sep}`)) return false;
        const normalized = filename.replaceAll(sep, "/");
        for (const ignoredDir of this.ignoredDirs) {
          if (normalized === ignoredDir || normalized.startsWith(ignoredDir + "/")) return false;
        }
        return true;
      },
      normalizeKey: (filename) => filename.replaceAll(sep, "/"),
      onFlush: (changes) => this.request((work) => addChanges(work, changes)),
      onUnknownChange: () =>
        this.request((work) => {
          work.rescanAll = true;
        }),
    });
  }

  async start(): Promise<void> {
    await this.buildStatusMaps();
    this.syncService.start();
  }

  stop(): void {
    this.stopped = true;
    this.syncService.stop();
    // Nothing will run the queued pass any more; release whoever is waiting on it.
    for (const resolve of this.pending?.waiters ?? []) resolve();
    this.pending = null;
    this.dirCache.clear();
    this.pendingReads.clear();
    this.fileStatusMap.clear();
    this.dirStatusMap.clear();
    this.ignoredDirs.clear();
    this.ignoredFiles.clear();
    this.untrackedDirs.clear();
    this.status = null;
  }

  async pauseWatching(): Promise<void> {
    await this.syncService.pause();
    await this.draining;
  }

  async resumeWatching(): Promise<void> {
    await this.syncService.resume();
  }

  /** The most recent status snapshot, or null before the first successful read. */
  getStatusSnapshot(): StatusInfo | null {
    return this.status;
  }

  /**
   * Write a file with nonce tracking for echo detection.
   * The write callback is injected to allow git-commands validation.
   */
  async writeFile(filePath: string, nonce: string, writeFn: () => Promise<void>): Promise<void> {
    await this.syncService.writeWithNonce(filePath, nonce, writeFn);
  }

  /**
   * Get directory contents, classified with git status.
   * Results are cached — subsequent calls return from cache until
   * invalidated by a fs event or `unwatchDir`.
   */
  async getDirContents(dir: string): Promise<DirEntry[]> {
    const cached = this.dirCache.get(dir);
    if (cached) return cached;

    // Deduplicate concurrent reads for the same directory
    const pending = this.pendingReads.get(dir);
    if (pending) return pending;

    const promise = this.readAndClassifyDir(dir);
    this.pendingReads.set(dir, promise);
    try {
      return await promise;
    } finally {
      this.pendingReads.delete(dir);
    }
  }

  /**
   * Clear the cache for a directory and all its descendants.
   * Called when the client collapses a directory so that re-expanding
   * fetches fresh data from disk.
   */
  unwatchDir(dir: string): void {
    this.dirCache.delete(dir);

    // Clear caches for all descendants
    const prefix = dir ? dir + "/" : "";
    for (const watchedDir of this.dirCache.keys()) {
      if (dir === "" || watchedDir.startsWith(prefix)) {
        this.dirCache.delete(watchedDir);
      }
    }
  }

  /**
   * Explicitly notify the service that files at the given relative paths changed.
   * Used by file operation routes to bypass watcher debounce for self-initiated changes.
   * Triggers the same logic as a detected filesystem event: rebuilds git status,
   * re-reads affected cached directories, and broadcasts changes to clients.
   * Resolves once a pass that includes these paths has completed.
   */
  async notifyChanges(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    await this.request((work) => {
      // For directory deletions, clean up cached subdirectories that no longer exist on disk
      for (const key of keys) work.purgeDirs.add(key);
      addChanges(
        work,
        keys.map((key) => ({ key, nonces: [] })),
      );
    });
  }

  /**
   * Re-read the git status and every cached directory. Called when the git dir changed (index,
   * HEAD, refs, stash). Resolves once a pass started after this call has completed; the new
   * status is delivered through `onStatusChanged`.
   */
  async refreshGitStatus(): Promise<void> {
    await this.request((work) => {
      work.rescanAll = true;
    });
  }

  // --- Private implementation ---

  /**
   * Merge work into the next pass and make sure the drain loop runs. The returned promise
   * settles when the pass carrying this work finishes, and never rejects: a failed git read is
   * logged and the previous status kept.
   */
  private request(add: (work: PendingRefresh) => void): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const work = (this.pending ??= emptyPendingRefresh());
    add(work);
    const done = new Promise<void>((resolve) => {
      work.waiters.push(resolve);
    });
    this.drain();
    return done;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      // Yield first so `this.draining` is assigned before the loop can possibly finish.
      await Promise.resolve();
      try {
        while (this.pending && !this.stopped) {
          const work = this.pending;
          this.pending = null;
          try {
            await this.runPass(work);
          } catch (err) {
            log.error("File tree refresh failed", { error: err });
          } finally {
            for (const resolve of work.waiters) resolve();
          }
        }
      } finally {
        // Cleared synchronously after the last `pending` check, so a request arriving from
        // here on starts a new loop instead of stranding its work.
        this.draining = null;
      }
    })();
  }

  private async runPass(work: PendingRefresh): Promise<void> {
    for (const key of work.purgeDirs) {
      const prefix = key + "/";
      for (const cachedDir of this.dirCache.keys()) {
        if (cachedDir === key || cachedDir.startsWith(prefix)) {
          this.dirCache.delete(cachedDir);
        }
      }
    }

    // Always rebuild git status so changes anywhere in the tree (including
    // collapsed directories) propagate correct colors to visible parents.
    const status = await this.buildStatusMaps();
    if (this.stopped) return;
    if (status) this.onStatusChanged?.(status);

    if (work.rescanAll) {
      // Snapshot keys — readAndClassifyDir may delete entries on error
      for (const dir of Array.from(this.dirCache.keys())) {
        if (this.stopped) return;
        await this.rereadDir(dir);
      }
    } else {
      await this.applyFileChanges(work.changes);
    }
    if (this.stopped) return;

    // Emit per-file change events for editor live updates
    if (this.onFileChanged) {
      for (const [key, nonces] of work.changes) {
        this.onFileChanged(join(this.worktreeCwd, key), nonces);
      }
    }
  }

  /** Re-read the cached parents of changed paths; reclassify every other cached directory. */
  private async applyFileChanges(changes: Map<string, string[]>): Promise<void> {
    const parentDirs = new Set<string>();
    for (const key of changes.keys()) {
      const slashIdx = key.lastIndexOf("/");
      const parentDir = slashIdx === -1 ? "" : key.substring(0, slashIdx);
      if (this.dirCache.has(parentDir)) {
        parentDirs.add(parentDir);
      }
    }

    // Re-read cached directories that had direct children change
    for (const dir of parentDirs) {
      if (this.stopped) return;
      await this.rereadDir(dir);
    }

    // Reclassify cached directories that had NO direct children change but whose
    // entries may have new status colors (e.g. a collapsed subfolder turning blue
    // because a file was added inside it). Only updates status — no disk reads.
    for (const [dir, oldEntries] of this.dirCache) {
      if (parentDirs.has(dir)) continue; // already re-read above
      const newEntries = this.reclassifyEntries(dir, oldEntries);
      if (!entriesEqual(oldEntries, newEntries)) {
        this.dirCache.set(dir, newEntries);
        this.onDirChanged(this.absDir(dir), newEntries);
      }
    }
  }

  /** Re-read one cached directory from disk and broadcast it if its entries changed. */
  private async rereadDir(dir: string): Promise<void> {
    const oldEntries = this.dirCache.get(dir);
    // Force re-read by deleting cache entry
    this.dirCache.delete(dir);
    const newEntries = await this.readAndClassifyDir(dir);
    if (!oldEntries || !entriesEqual(oldEntries, newEntries)) {
      this.onDirChanged(this.absDir(dir), newEntries);
    }
  }

  /**
   * Read git status and the ignored set, and rebuild the status maps from them.
   *
   * Returns the status, or null when it could not be read. The previous maps (ignored set
   * included, so they stay consistent) are then kept rather than wiped, so a transient failure
   * does not repaint the whole tree as clean; a failed ignored-files listing likewise keeps the
   * previous ignored set.
   */
  private async buildStatusMaps(): Promise<StatusInfo | null> {
    const [status, ignoredOutput] = await Promise.all([
      getStatus(this.worktreeCwd).catch((err: unknown) => {
        // A removed worktree is an expected lifecycle race, not an error.
        if (existsSync(this.worktreeCwd)) {
          log.error("Failed to run git status for file tree", { error: err });
        }
        return null;
      }),
      $`git -C ${this.worktreeCwd} ls-files --others --ignored --exclude-standard --directory -z`
        .env(readOnlyGitEnv())
        .text()
        .catch((err: unknown) => {
          if (existsSync(this.worktreeCwd)) {
            log.error("Failed to list ignored files for file tree", { error: err });
          }
          return null;
        }),
    ]);
    if (this.stopped || !status) return null;

    if (ignoredOutput !== null) {
      this.ignoredDirs.clear();
      this.ignoredFiles.clear();
      for (const entry of ignoredOutput.split("\0")) {
        if (!entry) continue;
        // Ignored directory — stored without trailing slash
        if (entry.endsWith("/")) this.ignoredDirs.add(entry.slice(0, -1));
        else this.ignoredFiles.add(entry);
      }
    }
    this.status = status;
    this.fileStatusMap = deriveFileStatuses(status);
    this.untrackedDirs = new Set(
      status.untracked.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1)),
    );
    for (const file of this.ignoredFiles) this.fileStatusMap.set(file, "ignored");

    // Derive directory statuses by walking up parent paths.
    // Any dir containing modified or untracked content is "modified" (blue) —
    // having new content in an existing dir means the dir changed.
    this.dirStatusMap = new Map();
    for (const [filePath, fileStatus] of this.fileStatusMap) {
      if (fileStatus === "ignored") continue;
      markParentsModified(this.dirStatusMap, filePath);
    }
    // Untracked dirs also propagate "modified" up to their parents
    for (const untrackedDir of this.untrackedDirs) {
      markParentsModified(this.dirStatusMap, untrackedDir);
    }

    // Fully new directories (git reports as `? dir/`) are "untracked" (green),
    // overriding the "modified" set above for the dir itself (parents stay blue).
    for (const dir of this.untrackedDirs) {
      this.dirStatusMap.set(dir, "untracked");
    }
    // Ignored directories override everything
    for (const dir of this.ignoredDirs) {
      this.dirStatusMap.set(dir, "ignored");
    }
    return status;
  }

  /** Check if a path is inside an ignored directory. */
  private isInsideIgnoredDir(dirPath: string): boolean {
    if (this.ignoredDirs.has(dirPath)) return true;
    const parts = dirPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (this.ignoredDirs.has(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  }

  /** Check if a path is inside an untracked directory. */
  private isInsideUntrackedDir(dirPath: string): boolean {
    if (this.untrackedDirs.has(dirPath)) return true;
    const parts = dirPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (this.untrackedDirs.has(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  }

  /** Check which paths are ignored by gitignore. Returns the set of ignored paths. */
  private async checkIgnored(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    // NUL-separated both ways: otherwise names with quotes or non-ASCII bytes come back quoted.
    // Non-empty by the guard above — Bun's shell never closes stdin for an empty Buffer.
    const input = Buffer.from(paths.join("\0"));
    const result = await $`git -C ${this.worktreeCwd} check-ignore --stdin -z < ${input}`
      .env(readOnlyGitEnv())
      .nothrow()
      .quiet();
    // Exit code 1 just means none of the paths are ignored.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      log.warn("git check-ignore failed", { stderr: result.stderr.toString().trim() });
      return new Set();
    }
    return new Set(result.stdout.toString().split("\0").filter(Boolean));
  }

  private async readAndClassifyDir(dir: string): Promise<DirEntry[]> {
    const fullPath = dir ? join(this.worktreeCwd, dir) : this.worktreeCwd;

    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await readdir(fullPath, { withFileTypes: true });
    } catch (err) {
      log.error(`Failed to read directory ${dir || "(root)"}`, { error: err });
      this.dirCache.delete(dir);
      return [];
    }

    // If this directory is inside an ignored dir, all children inherit "ignored".
    // If inside an untracked dir, children default to "untracked" but may be
    // overridden to "ignored" by gitignore rules (checked via git check-ignore).
    const parentIgnored = dir !== "" && this.isInsideIgnoredDir(dir);
    const parentUntracked = !parentIgnored && dir !== "" && this.isInsideUntrackedDir(dir);

    // When inside an untracked dir, git ls-files --ignored doesn't report children.
    // Use git check-ignore to find which children are actually ignored.
    let ignoredInUntracked: Set<string> | null = null;
    if (parentUntracked) {
      ignoredInUntracked = await this.checkIgnored(
        dirents.filter((d) => d.name !== ".git").map((d) => (dir ? `${dir}/${d.name}` : d.name)),
      );
    }

    const entries: DirEntry[] = [];
    for (const dirent of dirents) {
      // Only skip .git directory
      if (dirent.name === ".git") continue;

      const entryPath = dir ? `${dir}/${dirent.name}` : dirent.name;
      const isDir = dirent.isDirectory();

      let status: ProjectFileStatus;
      if (parentIgnored) {
        status = "ignored";
      } else if (parentUntracked) {
        status = ignoredInUntracked?.has(entryPath) ? "ignored" : "untracked";
      } else if (isDir) {
        if (this.ignoredDirs.has(entryPath)) {
          status = "ignored";
        } else {
          status = this.dirStatusMap.get(entryPath) ?? "normal";
        }
      } else {
        status = this.fileStatusMap.get(entryPath) ?? "normal";
      }

      entries.push({ name: dirent.name, path: join(this.worktreeCwd, entryPath), isDir, status });
    }

    // Sort: dirs first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    this.dirCache.set(dir, entries);
    return entries;
  }

  /** Convert a relative dir to absolute for broadcast (empty string = worktree root). */
  private absDir(dir: string): string {
    return dir ? join(this.worktreeCwd, dir) : this.worktreeCwd;
  }

  /** Reclassify existing entries with current status maps (no disk I/O). */
  private reclassifyEntries(dir: string, entries: DirEntry[]): DirEntry[] {
    return entries.map((entry) => {
      const entryPath = dir ? `${dir}/${entry.name}` : entry.name;
      let status: ProjectFileStatus;
      if (entry.isDir) {
        if (this.ignoredDirs.has(entryPath)) {
          status = "ignored";
        } else {
          status = this.dirStatusMap.get(entryPath) ?? "normal";
        }
      } else {
        status = this.fileStatusMap.get(entryPath) ?? "normal";
      }
      return status === entry.status ? entry : { ...entry, status };
    });
  }
}

/** Compare two DirEntry arrays for equality (same entries in same order). */
function entriesEqual(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ae = a[i]!;
    const be = b[i]!;
    if (
      ae.name !== be.name ||
      ae.path !== be.path ||
      ae.isDir !== be.isDir ||
      ae.status !== be.status
    )
      return false;
  }
  return true;
}

/**
 * File path → tree status for every path git reports.
 *
 * A deletion on one side with the other side untouched is skipped: the file is not on disk, so
 * there is no entry to color. Everything else with a change — modifications, additions, the new
 * side of renames and copies, conflicts — is "modified". Untracked directories (`dir/`) are not
 * files and are handled separately.
 */
function deriveFileStatuses(status: StatusInfo): Map<string, ProjectFileStatus> {
  const sides = new Map<string, { staged?: string; unstaged?: string }>();
  for (const entry of status.staged) {
    sides.set(entry.path, { ...sides.get(entry.path), staged: entry.status });
  }
  for (const entry of status.unstaged) {
    sides.set(entry.path, { ...sides.get(entry.path), unstaged: entry.status });
  }

  const map = new Map<string, ProjectFileStatus>();
  for (const [path, { staged, unstaged }] of sides) {
    if ((staged === "D" && !unstaged) || (unstaged === "D" && !staged)) continue;
    map.set(path, "modified");
  }
  for (const entry of status.conflicted) map.set(entry.path, "modified");
  for (const path of status.untracked) {
    if (!path.endsWith("/")) map.set(path, "untracked");
  }
  return map;
}

/** Mark every ancestor directory of `path` as modified. */
function markParentsModified(dirStatusMap: Map<string, ProjectFileStatus>, path: string): void {
  let slash = path.indexOf("/");
  while (slash !== -1) {
    dirStatusMap.set(path.slice(0, slash), "modified");
    slash = path.indexOf("/", slash + 1);
  }
}

function emptyPendingRefresh(): PendingRefresh {
  return { changes: new Map(), purgeDirs: new Set(), rescanAll: false, waiters: [] };
}

/** Merge a flush batch into pending work, keeping every nonce matched for a key. */
function addChanges(work: PendingRefresh, changes: FileChange[]): void {
  for (const { key, nonces } of changes) {
    work.changes.set(key, [...(work.changes.get(key) ?? []), ...nonces]);
  }
}
