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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingKeys = new Set<string>();
  private hasUnknownChange = false;
  /** Multiple nonces can be pending per key when overlapping saves occur. */
  private nonces = new Map<string, NonceEntry[]>();
  private readonly debounceMs: number;
  private readonly nonceExpiryMs: number;

  constructor(private options: FilesSyncOptions) {
    this.debounceMs = options.debounceMs ?? 10;
    this.nonceExpiryMs = options.nonceExpiryMs ?? 5_000;
  }

  start(): void {
    const watchDir = this.options.watchDir;
    if (!watchDir) return; // Individual file mode — files added via watchFile()

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
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    for (const [, watcher] of this.fileWatchers) {
      watcher.close();
    }
    this.fileWatchers.clear();
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
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
        const result = this.options.onUnknownChange();
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            log.error("Failed to handle unknown file change", { error: err });
          });
        }
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
      const result = this.options.onFlush(changes);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          log.error("Failed to process file change flush", { error: err });
        });
      }
    } catch (err) {
      log.error("Failed to process file change flush", { error: err });
    }
  }
}
