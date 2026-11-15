/**
 * An NDJSON log file of one process: writes are batched and flushed every half second or 4 KiB,
 * and once the file passes 5 MB it is renamed to `<path>.1`, replacing the previous one, and a new
 * file is started. Used by the server's logger and the terminal host's. Best effort: a failing
 * write never throws.
 */
import { renameSync, statSync } from "node:fs";

import type { FileSink } from "bun";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 500;
const FLUSH_BYTES = 4096;

export class LogFile {
  private writer: FileSink | null = null;
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly path: string) {}

  write(line: string): void {
    this.rotateIfNeeded();
    try {
      this.writer ??= Bun.file(this.path).writer();
      this.writer.write(line);
    } catch {
      return;
    }
    this.pendingBytes += line.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
    else this.scheduleFlush();
  }

  /** Flush and close the file; a later write opens it again. */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.end();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    // Logging must not keep a process alive that is otherwise done.
    this.flushTimer.unref();
  }

  private flush(): void {
    if (!this.writer) return;
    try {
      void this.writer.flush();
      this.pendingBytes = 0;
    } catch {
      // Non-fatal: logs are best effort.
    }
  }

  private end(): void {
    if (!this.writer) return;
    try {
      void this.writer.flush();
      void this.writer.end();
    } catch {
      // Non-fatal: logs are best effort.
    }
    this.writer = null;
    this.pendingBytes = 0;
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.path).size <= MAX_FILE_BYTES) return;
      this.end();
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // Not written yet, or the stat failed: nothing to rotate.
    }
  }
}
