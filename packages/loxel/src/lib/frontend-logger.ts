/**
 * Frontend structured logger.
 *
 * Mirrors the server logger's `child()` API but sends entries to the server
 * via `POST /api/log`, where they are assigned IDs, persisted, and broadcast
 * through the same pipeline as server-originated logs.
 */

import { postLogEntry } from "@/api/client";
import type { ChildLogger, LogCategory, LogLevel } from "@/api/log-entry-model";
import { serializeLogContext } from "@/api/log-entry-model";

// --- Core ---

function emit(level: LogLevel, cat: LogCategory, msg: string, ctx?: Record<string, unknown>): void {
  postLogEntry({
    level,
    cat,
    msg,
    ctx: ctx && Object.keys(ctx).length > 0 ? serializeLogContext(ctx) : undefined,
  });
}

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

/** Frontend logger — same API as the server logger's `child()`. */
export const frontendLog = { child: createChild };
