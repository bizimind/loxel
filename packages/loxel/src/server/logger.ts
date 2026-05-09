/**
 * Structured logger for loxel server.
 *
 * Writes NDJSON to a per-instance log file, keeps an in-memory ring buffer
 * for the REST history endpoint, and batches broadcasts to WebSocket clients.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { ChildLogger, LogCategory, LogEntry, LogLevel } from "@/api/log-entry-model";

import { LOG_LEVEL_PRIORITY } from "@/api/log-entry-model";

import { config } from "./config";

// --- Constants ---

const MAX_RING_BUFFER = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const FLUSH_INTERVAL_MS = 500;
const BROADCAST_INTERVAL_MS = 100;
const STALE_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const BROADCAST_MIN_LEVEL: LogLevel = "info";

// --- Instance ID & paths ---

const instanceId = crypto.randomUUID().slice(0, 8);
const logsDir = join(config.stateDir, "logs");
const logFilePath = join(logsDir, `server-${instanceId}.log`);

// Ensure logs directory exists
mkdirSync(logsDir, { recursive: true });

// --- File writer ---

let fileWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
let pendingFileBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getWriter() {
  if (!fileWriter) {
    fileWriter = Bun.file(logFilePath).writer();
  }
  return fileWriter;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushWriter();
  }, FLUSH_INTERVAL_MS);
}

function flushWriter() {
  if (!fileWriter) return;
  try {
    fileWriter.flush();
    pendingFileBytes = 0;
  } catch {
    // File I/O error — non-fatal, logs are best-effort
  }
}

function rotateIfNeeded() {
  try {
    const stat = statSync(logFilePath);
    if (stat.size > MAX_FILE_BYTES) {
      // Close current writer before rename
      if (fileWriter) {
        try {
          fileWriter.flush();
          fileWriter.end();
        } catch {
          // ignore
        }
        fileWriter = null;
        pendingFileBytes = 0;
      }
      renameSync(logFilePath, `${logFilePath}.1`);
    }
  } catch {
    // File doesn't exist yet or stat failed — nothing to rotate
  }
}

/** Remove stale log files from dead instances (older than 24h). */
function cleanupStaleLogs() {
  try {
    const now = Date.now();
    const files = readdirSync(logsDir);
    for (const file of files) {
      if (!file.startsWith("server-") || !file.endsWith(".log")) continue;
      // Skip our own file
      if (file === `server-${instanceId}.log`) continue;
      try {
        const filePath = join(logsDir, file);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > STALE_LOG_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
    // Also clean up .1 rotated files from stale instances
    for (const file of files) {
      if (!file.startsWith("server-") || !file.endsWith(".log.1")) continue;
      try {
        const filePath = join(logsDir, file);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > STALE_LOG_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Non-fatal
  }
}

// Clean up on startup
cleanupStaleLogs();

// --- Ring buffer ---

const ringBuffer: LogEntry[] = [];

function addToRing(entry: LogEntry) {
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_RING_BUFFER) {
    ringBuffer.shift();
  }
}

// --- Broadcast batching ---

type BroadcastFn = (entries: LogEntry[]) => void;
type ErrorCountFn = (delta: number) => void;

let broadcastFn: BroadcastFn | null = null;
let errorCountFn: ErrorCountFn | null = null;
let broadcastBatch: LogEntry[] = [];
let pendingErrorDelta = 0;
let totalErrorCount = 0;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    flushBroadcast();
  }, BROADCAST_INTERVAL_MS);
}

function flushBroadcast() {
  if (broadcastFn && broadcastBatch.length > 0) {
    const batch = broadcastBatch;
    broadcastBatch = [];
    broadcastFn(batch);
  }
  if (errorCountFn && pendingErrorDelta > 0) {
    const delta = pendingErrorDelta;
    pendingErrorDelta = 0;
    errorCountFn(delta);
  }
}

// --- Error serialization ---

function serializeErrorValue(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const result: Record<string, unknown> = { message: err.message, stack: err.stack };
    if (err.cause) {
      result.cause = serializeErrorValue(err.cause);
    }
    return result;
  }
  return { message: String(err) };
}

function serializeContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "error" && value instanceof Error) {
      result[key] = serializeErrorValue(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// --- Core logging ---

let nextId = 1;

function emit(level: LogLevel, cat: LogCategory, msg: string, ctx?: Record<string, unknown>) {
  const entry: LogEntry = { id: nextId++, ts: new Date().toISOString(), level, cat, msg };

  if (ctx && Object.keys(ctx).length > 0) {
    entry.ctx = serializeContext(ctx);
  }

  // Ring buffer (all levels)
  addToRing(entry);

  // File write (all levels)
  const line = JSON.stringify(entry) + "\n";
  rotateIfNeeded();
  const writer = getWriter();
  writer.write(line);
  pendingFileBytes += line.length;
  if (pendingFileBytes >= 4096) {
    flushWriter();
  } else {
    scheduleFlush();
  }

  // Broadcast (info+ only, batched)
  if (broadcastFn && LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[BROADCAST_MIN_LEVEL]) {
    broadcastBatch.push(entry);
    scheduleBroadcast();
  }

  // Error-count signal (always-on, batched) — independent of the entry broadcast
  // so the client badge works even without a log-entries subscription.
  // The running total is incremented unconditionally so a snapshot on
  // subscribe/reconnect can reconcile the client badge against prior errors.
  if (level === "error") {
    totalErrorCount += 1;
    pendingErrorDelta += 1;
    if (errorCountFn) scheduleBroadcast();
  }
}

// --- Child logger ---

function createChild(cat: LogCategory, defaultCtx?: Record<string, unknown>): ChildLogger {
  const mergeCtx = (ctx?: Record<string, unknown>) =>
    defaultCtx ? { ...defaultCtx, ...ctx } : ctx;

  return {
    debug: (msg, ctx) => emit("debug", cat, msg, mergeCtx(ctx)),
    info: (msg, ctx) => emit("info", cat, msg, mergeCtx(ctx)),
    warn: (msg, ctx) => emit("warn", cat, msg, mergeCtx(ctx)),
    error: (msg, ctx) => emit("error", cat, msg, mergeCtx(ctx)),
    flush: async () => {},
    with: (extraCtx) => createChild(cat, { ...defaultCtx, ...extraCtx }),
  };
}

// --- Public API ---

export const logger = {
  /** Create a scoped child logger for a category. */
  child: createChild,

  /** Ingest an externally-sourced log entry (e.g. from the frontend via POST /api/log). */
  ingest(level: LogLevel, cat: LogCategory, msg: string, ctx?: Record<string, unknown>) {
    emit(level, cat, msg, ctx);
  },

  /** Register the WebSocket broadcast callback. Call after server starts. */
  setBroadcast(fn: BroadcastFn) {
    broadcastFn = fn;
  },

  /** Register the always-on error-count broadcast callback. Call after server starts. */
  setErrorCountBroadcast(fn: ErrorCountFn) {
    errorCountFn = fn;
  },

  /**
   * Return the snapshot total of error-level log entries the server has
   * already broadcast (i.e. excluding any pending batched delta that hasn't
   * fired yet). Used by the reconciliation snapshot on `subscribe_logs` so a
   * socket subscribing mid-batch doesn't get the pending errors counted twice
   * (once in the snapshot, once in the subsequent delta broadcast).
   */
  getSnapshotTotal(): number {
    return totalErrorCount - pendingErrorDelta;
  },

  /**
   * Get historical log entries from the ring buffer.
   * Returns entries in reverse chronological order (newest first).
   */
  getHistory(before?: number, limit = 200): { entries: LogEntry[]; hasMore: boolean } {
    const capped = Math.min(limit, 500);

    let filtered: LogEntry[];
    if (before !== undefined) {
      // Binary search for the insertion point since IDs are monotonic
      // Find entries with id < before. IDs are monotonic so scan from the end.
      // If cursor was evicted (all entries >= before), end stays at ringBuffer.length
      // so we return everything — the client can still paginate.
      let end = ringBuffer.length;
      for (let i = ringBuffer.length - 1; i >= 0; i--) {
        if (ringBuffer[i]!.id < before) {
          end = i + 1;
          break;
        }
      }
      filtered = ringBuffer.slice(0, end);
    } else {
      filtered = ringBuffer;
    }

    const start = Math.max(0, filtered.length - capped);
    const entries = filtered.slice(start).reverse();
    const hasMore = start > 0;

    return { entries, hasMore };
  },

  /** Flush pending file writes and broadcasts. Call on shutdown. */
  shutdown() {
    // Flush pending broadcast
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    flushBroadcast();

    // Flush and close file writer
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (fileWriter) {
      try {
        fileWriter.flush();
        fileWriter.end();
      } catch {
        // ignore
      }
      fileWriter = null;
    }
  },

  /** The instance ID for this server process. */
  instanceId,

  /** Path to the log file. */
  logFilePath,
};
