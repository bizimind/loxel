import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

import { $ } from "bun";

import type { DirEntry, ProjectFileStatus } from "@/api/project-files-model";

import type { FileChange } from "./file-sync-service";
import { FilesSyncService } from "./file-sync-service";
import { logger } from "./logger";

const log = logger.child("files");

/**
 * Manages cached directory contents with git status overlay for a worktree.
 *
 * Composes with {@link FilesSyncService} for fs.watch lifecycle, debouncing,
 * and nonce-tracked writes. On each flush, rebuilds git status and updates
 * cached directory entries.
 *
 * Two separate concerns, two separate triggers:
 * - Directory contents (what files exist): updated when the watcher detects
 *   changes in a cached (expanded) directory
 * - Git statuses (what color each entry gets): rebuilt on every fs event so
 *   status changes propagate to parent folders even for collapsed directories
 */
export class ProjectFilesService {
  /** File path → git status (only non-normal files are stored). */
  private fileStatusMap = new Map<string, ProjectFileStatus>();
  /** Directory path → derived status (propagated from children via git status). */
  private dirStatusMap = new Map<string, ProjectFileStatus>();
  /** Ignored directory paths (from git ls-files --ignored --directory). */
  private ignoredDirs = new Set<string>();
  /** Untracked directory paths (from git status, entries like `?? dir/`). */
  private untrackedDirs = new Set<string>();

  /** Cached readdir results for directories the client has expanded. */
  private dirCache = new Map<string, DirEntry[]>();
  /** In-flight readdir promises to avoid duplicate concurrent reads. */
  private pendingReads = new Map<string, Promise<DirEntry[]>>();

  /**
   * Serialization queue for state mutations.
   * Multiple callers (notifyChanges, fs watcher flush, git index watcher)
   * can trigger concurrent handleFlush/refreshGitStatus/refreshCachedDirs calls
   * that mutate shared state (dirCache, status maps). Serializing prevents races
   * where one caller's entriesEqual check sees entries written by another caller
   * instead of the true "old" entries, suppressing onDirChanged broadcasts.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private syncService: FilesSyncService;

  constructor(
    private worktreeCwd: string,
    private onDirChanged: (dir: string, entries: DirEntry[]) => void,
    private onFileChanged?: (filePath: string, nonces: string[]) => void,
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
      onFlush: (changes) => this.enqueue(() => this.handleFlush(changes)),
      onUnknownChange: () => this.enqueue(() => this.refreshCachedDirs()),
    });
  }

  async start(): Promise<void> {
    await this.buildStatusMaps();
    this.syncService.start();
  }

  stop(): void {
    this.syncService.stop();
    this.dirCache.clear();
    this.pendingReads.clear();
    this.fileStatusMap.clear();
    this.dirStatusMap.clear();
    this.ignoredDirs.clear();
    this.untrackedDirs.clear();
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
   */
  async notifyChanges(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    await this.enqueue(async () => {
      // For directory deletions, clean up cached subdirectories that no longer exist on disk
      for (const key of keys) {
        const prefix = key + "/";
        for (const cachedDir of this.dirCache.keys()) {
          if (cachedDir === key || cachedDir.startsWith(prefix)) {
            this.dirCache.delete(cachedDir);
          }
        }
      }

      await this.handleFlush(keys.map((key) => ({ key, nonces: [] })));
    });
  }

  /**
   * Re-read all cached (expanded) directories from disk and broadcast changes.
   * Called when fs.watch fires with a null filename — the platform detected a
   * change but couldn't identify which file, so we re-scan everything visible.
   * Cheaper than refreshGitStatus (no git commands, just readdir).
   */
  private async refreshCachedDirs(): Promise<void> {
    await this.buildStatusMaps();
    for (const dir of Array.from(this.dirCache.keys())) {
      const oldEntries = this.dirCache.get(dir);
      this.dirCache.delete(dir);
      const newEntries = await this.readAndClassifyDir(dir);
      if (!oldEntries || !entriesEqual(oldEntries, newEntries)) {
        this.onDirChanged(this.absDir(dir), newEntries);
      }
    }
  }

  /**
   * Refresh git status maps and update all cached directories.
   * Called from the existing FileWatcher when the git index changes.
   */
  async refreshGitStatus(): Promise<void> {
    await this.enqueue(async () => {
      await this.buildStatusMaps();

      // Snapshot keys — readAndClassifyDir may delete entries on error
      for (const dir of Array.from(this.dirCache.keys())) {
        const oldEntries = this.dirCache.get(dir);
        const newEntries = await this.readAndClassifyDir(dir);

        // Only broadcast if entries actually changed
        if (!oldEntries || !entriesEqual(oldEntries, newEntries)) {
          this.onDirChanged(this.absDir(dir), newEntries);
        }
      }
    });
  }

  // --- Private implementation ---

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async handleFlush(changes: FileChange[]): Promise<void> {
    // Derive parent dirs for cached dir re-reads
    const parentDirs = new Set<string>();
    for (const { key } of changes) {
      const slashIdx = key.lastIndexOf("/");
      const parentDir = slashIdx === -1 ? "" : key.substring(0, slashIdx);
      if (this.dirCache.has(parentDir)) {
        parentDirs.add(parentDir);
      }
    }

    // Always rebuild git status so changes anywhere in the tree (including
    // collapsed directories) propagate correct colors to visible parents.
    await this.buildStatusMaps();

    // Re-read cached directories that had direct children change
    for (const dir of parentDirs) {
      const oldEntries = this.dirCache.get(dir);
      // Force re-read by deleting cache entry
      this.dirCache.delete(dir);
      const newEntries = await this.readAndClassifyDir(dir);

      if (!oldEntries || !entriesEqual(oldEntries, newEntries)) {
        this.onDirChanged(this.absDir(dir), newEntries);
      }
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

    // Emit per-file change events for editor live updates
    if (this.onFileChanged) {
      for (const { key, nonces } of changes) {
        this.onFileChanged(join(this.worktreeCwd, key), nonces);
      }
    }
  }

  private async buildStatusMaps(): Promise<void> {
    const [statusOutput, ignoredOutput] = await Promise.all([
      $`git -C ${this.worktreeCwd} status --porcelain`.text().catch((err: unknown) => {
        log.error("Failed to run git status for file tree", { error: err });
        return "";
      }),
      $`git -C ${this.worktreeCwd} ls-files --others --ignored --exclude-standard --directory`
        .text()
        .catch((err: unknown) => {
          log.error("Failed to list ignored files for file tree", { error: err });
          return "";
        }),
    ]);

    this.fileStatusMap.clear();
    this.dirStatusMap.clear();
    this.ignoredDirs.clear();
    this.untrackedDirs.clear();

    // Parse git status --porcelain output
    for (const line of statusOutput.split("\n")) {
      if (!line || line.length < 4) continue;
      const xy = line.substring(0, 2);
      let filePath = line.substring(3);

      if (xy === "??") {
        if (filePath.endsWith("/")) {
          // Untracked directory — git reports the dir instead of individual files
          const dirPath = filePath.slice(0, -1);
          this.untrackedDirs.add(dirPath);
          this.dirStatusMap.set(dirPath, "untracked");
        } else {
          this.fileStatusMap.set(filePath, "untracked");
        }
      } else if (xy === "!!") {
        // Ignored (only appears with --ignored flag, but we use ls-files for that)
        this.fileStatusMap.set(filePath, "ignored");
      } else {
        // Any other status (M, A, D, R, C, etc.) = modified
        // Skip deleted files — they don't exist on disk
        const indexStatus = xy[0];
        const worktreeStatus = xy[1];
        if (indexStatus === "D" && worktreeStatus === " ") continue;
        if (worktreeStatus === "D" && indexStatus === " ") continue;

        // Renames/copies: format is "old_path -> new_path" — use the new path
        if (indexStatus === "R" || indexStatus === "C") {
          const arrowIdx = filePath.indexOf(" -> ");
          if (arrowIdx !== -1) {
            filePath = filePath.substring(arrowIdx + 4);
          }
        }

        this.fileStatusMap.set(filePath, "modified");
      }
    }

    // Parse ignored files/dirs
    for (const line of ignoredOutput.split("\n")) {
      if (!line) continue;
      if (line.endsWith("/")) {
        // Ignored directory — store without trailing slash
        this.ignoredDirs.add(line.slice(0, -1));
      } else {
        this.fileStatusMap.set(line, "ignored");
      }
    }

    // Derive directory statuses by walking up parent paths.
    // Any dir containing modified or untracked content is "modified" (blue) —
    // having new content in an existing dir means the dir changed.
    for (const [filePath, status] of this.fileStatusMap) {
      if (status === "ignored") continue;
      const parts = filePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        this.dirStatusMap.set(parts.slice(0, i).join("/"), "modified");
      }
    }
    // Untracked dirs also propagate "modified" up to their parents
    for (const untrackedDir of this.untrackedDirs) {
      const parts = untrackedDir.split("/");
      for (let i = 1; i < parts.length; i++) {
        this.dirStatusMap.set(parts.slice(0, i).join("/"), "modified");
      }
    }

    // Fully new directories (git reports as `?? dir/`) are "untracked" (green),
    // overriding the "modified" set above for the dir itself (parents stay blue).
    for (const dir of this.untrackedDirs) {
      this.dirStatusMap.set(dir, "untracked");
    }
    // Ignored directories override everything
    for (const dir of this.ignoredDirs) {
      this.dirStatusMap.set(dir, "ignored");
    }
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
    try {
      const input = paths.join("\n");
      const result =
        await $`echo ${input} | git -C ${this.worktreeCwd} check-ignore --stdin`.text();
      return new Set(result.trim().split("\n").filter(Boolean));
    } catch {
      // git check-ignore exits with 1 when no paths are ignored
      return new Set();
    }
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
