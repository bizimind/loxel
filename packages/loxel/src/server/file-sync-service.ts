import { watch, type FSWatcher } from "node:fs";

import { logger } from "./logger";
import { stress } from "./stress-detector";

const log = logger.child("files");

interface NonceEntry {
  nonce: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface FileChange {
  key: string;
  /** All nonces matched for this key. Empty = external/unknown change. */
  nonces: string[];
}

export interface FilesSyncOptions {
  /** Directory to watch. Omit to start with an empty watcher (for individual file watching). */
  watchDir?: string;
  /** Whether to watch recursively (true for project trees, false for flat dirs). */
  recursive: boolean;
  /** Debounce interval in ms (default: 50). */
  debounceMs?: number;
  /** Nonce auto-expiry in ms (default: 5000). */
  nonceExpiryMs?: number;
  /**
   * Filter function called for each raw fs event filename.
   * Return true to accept the event, false to ignore it.
   */
  filter?: (filename: string) => boolean;
  /**
   * Normalize the raw filename to a stable key used for
   * nonce matching and reported in the flush batch.
   */
  normalizeKey?: (filename: string) => string;
  /**
   * Called once per debounce window with all accumulated change keys
   * and their matched nonces (empty array if no nonce was pending).
   */
  onFlush: (changes: FileChange[]) => void | Promise<void>;
  /**
   * Called when fs.watch fires with a null filename (platform couldn't
   * identify which file changed). Lets the consumer re-read cached state
   * as a fallback. Debounced alongside normal events.
   */
  onUnknownChange?: () => void | Promise<void>;
}

/**
 * Shared file-watching and nonce-tracking service.
 *
 * Owns: fs.watch lifecycle, event debouncing, nonce storage + auto-expiry,
 * nonce matching on flush. Composed by ProjectFilesService and
 * DetachedFilesService to eliminate duplicated watch/nonce boilerplate.
 *
 * Uses Node's native fs.watch which leverages macOS FSEvents for zero-overhead
 * recursive watching (no initial directory scan, unlike chokidar v5 which
 * enumerates every file and creates per-file watchers).
 */
export class FilesSyncService {
  private dirWatcher: FSWatcher | null = null;
  private fileWatchers = new Map<string, FSWatcher>();
  private watchedFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingKeys = new Set<string>();
  private hasUnknownChange = false;
  /** Multiple nonces can be pending per key when overlapping saves occur. */
  private nonces = new Map<string, NonceEntry[]>();
  private readonly debounceMs: number;
  private readonly nonceExpiryMs: number;
  private started = false;
  private paused = false;
  private activeFlushes = new Set<Promise<void>>();

  constructor(private options: FilesSyncOptions) {
    this.debounceMs = options.debounceMs ?? 10;
    this.nonceExpiryMs = options.nonceExpiryMs ?? 5_000;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.paused = false;
    this.attachWatchers();
  }

  /** Temporarily stop event delivery without discarding caches, files, or nonce state. */
  async pause(): Promise<void> {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.closeActiveWatchers();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await Promise.allSettled([...this.activeFlushes]);
  }

  /** Resume a paused service and conservatively resynchronize changes missed while paused. */
  async resume(): Promise<void> {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.attachWatchers();
    // fs.watch has no replay. Conservatively catch up anything that changed
    // while handles were closed on a failed worktree removal.
    if (this.options.watchDir && this.options.onUnknownChange) this.hasUnknownChange = true;
    for (const path of this.watchedFiles) this.pendingKeys.add(path);
    // Writes performed through the service while paused still need their normal
    // nonce-bearing echo so the originating editor does not see a false conflict.
    for (const key of this.nonces.keys()) this.pendingKeys.add(key);
    if (this.pendingKeys.size > 0 || this.hasUnknownChange) await this.flush();
  }

  private attachWatchers(): void {
    const watchDir = this.options.watchDir;
    if (watchDir) this.attachDirectoryWatcher(watchDir);
    for (const path of this.watchedFiles) this.attachFileWatcher(path);
  }

  private attachDirectoryWatcher(watchDir: string): void {
    if (this.dirWatcher) return;
    try {
      this.dirWatcher = watch(
        watchDir,
        { recursive: this.options.recursive },
        (_event, filename) => {
          if (!filename) {
            // Platform couldn't identify which file changed — schedule a
            // fallback refresh so the consumer can re-read cached state.
            if (this.options.onUnknownChange) {
              this.hasUnknownChange = true;
              this.scheduleFlush();
            }
            return;
          }
          if (this.options.filter && !this.options.filter(filename)) return;
          const key = this.options.normalizeKey ? this.options.normalizeKey(filename) : filename;
          this.pendingKeys.add(key);
          this.scheduleFlush();
        },
      );

      this.dirWatcher.on("error", (err) => {
        log.error("File system watcher error", { dir: watchDir, error: err });
      });
    } catch (err) {
      log.error("Failed to start file system watcher", { dir: watchDir, error: err });
    }
  }

  stop(): void {
    this.started = false;
    this.paused = false;
    this.closeActiveWatchers();
    this.watchedFiles.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const entries of this.nonces.values()) {
      for (const entry of entries) clearTimeout(entry.timer);
    }
    this.nonces.clear();
    this.pendingKeys.clear();
    this.hasUnknownChange = false;
  }

  /**
   * Add an individual file to the watcher. Uses a per-file fs.watch listener.
   * The file's absolute path is used as the change key in flush callbacks.
   */
  watchFile(absolutePath: string): void {
    if (this.watchedFiles.has(absolutePath)) return;
    this.watchedFiles.add(absolutePath);
    if (!this.started || this.paused) return;
    this.attachFileWatcher(absolutePath);
  }

  private attachFileWatcher(absolutePath: string): void {
    if (this.fileWatchers.has(absolutePath)) return;
    try {
      const watcher = watch(absolutePath, () => {
        this.pendingKeys.add(absolutePath);
        this.scheduleFlush();
      });
      watcher.on("error", (err) => {
        log.error("File watcher error", { path: absolutePath, error: err });
        this.fileWatchers.delete(absolutePath);
      });
      this.fileWatchers.set(absolutePath, watcher);
    } catch (err) {
      log.error("Failed to watch file", { path: absolutePath, error: err });
    }
  }

  /** Remove an individual file from the watcher. */
  unwatchFile(absolutePath: string): void {
    this.watchedFiles.delete(absolutePath);
    const watcher = this.fileWatchers.get(absolutePath);
    if (watcher) {
      watcher.close();
      this.fileWatchers.delete(absolutePath);
    }
  }

  /**
   * Inject a change event without waiting for the filesystem watcher.
   * Used for echoing changes back immediately (e.g. after a write).
   */
  pushChange(key: string): void {
    this.pendingKeys.add(key);
    this.scheduleFlush();
  }

  /**
   * Store a nonce for a key, execute the write callback, and set up auto-expiry.
   * The nonce will be matched against fs events in the next flush.
   * Multiple nonces can accumulate per key when overlapping saves occur.
   */
  async writeWithNonce(key: string, nonce: string, writeFn: () => Promise<void>): Promise<void> {
    const timer = setTimeout(() => {
      const entries = this.nonces.get(key);
      if (!entries) return;
      const idx = entries.findIndex((e) => e.nonce === nonce);
      if (idx !== -1) {
        entries.splice(idx, 1);
        if (entries.length === 0) this.nonces.delete(key);
      }
    }, this.nonceExpiryMs);

    const entries = this.nonces.get(key) ?? [];
    entries.push({ nonce, timer });
    this.nonces.set(key, entries);

    await writeFn();
  }

  private scheduleFlush(): void {
    if (this.paused) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private flush(): Promise<void> {
    const task = this.processFlush();
    this.activeFlushes.add(task);
    void task.finally(() => this.activeFlushes.delete(task));
    return task;
  }

  private async processFlush(): Promise<void> {
    stress.track("fs-flush");
    const unknownChange = this.hasUnknownChange;
    this.hasUnknownChange = false;

    const keys = [...this.pendingKeys];
    this.pendingKeys.clear();

    // If we received a null-filename event, notify the consumer to re-read.
    // Always call this when set — the unknown event may cover files that
    // the keyed changes missed.
    if (unknownChange && this.options.onUnknownChange) {
      try {
        await this.options.onUnknownChange();
      } catch (err) {
        log.error("Failed to handle unknown file change", { error: err });
      }
      if (keys.length === 0) return;
    }

    const changes: FileChange[] = keys.map((key) => {
      const entries = this.nonces.get(key);
      const nonces = entries ? entries.map((e) => e.nonce) : [];
      if (entries) {
        for (const entry of entries) clearTimeout(entry.timer);
        this.nonces.delete(key);
      }
      return { key, nonces };
    });

    try {
      await this.options.onFlush(changes);
    } catch (err) {
      log.error("Failed to process file change flush", { error: err });
    }
  }

  private closeActiveWatchers(): void {
    this.dirWatcher?.close();
    this.dirWatcher = null;
    for (const watcher of this.fileWatchers.values()) watcher.close();
    this.fileWatchers.clear();
  }
}
