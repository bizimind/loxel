/**
 * Stress detection for critical paths.
 *
 * Monitors call rates at named checkpoints and logs warnings/errors when
 * thresholds are exceeded. Detection only — no throttling or corrective action.
 *
 * Two modes:
 * - Rate-only: detects when a checkpoint fires above a configured rate.
 * - Rate + params: detects when the same checkpoint fires with identical
 *   parameters above the configured rate (loop detection).
 *
 * Cooldown: after an error alert fires, further logs for that counter are
 * suppressed for `cooldownWindows` consecutive windows. When the cooldown
 * expires (or the counter drops below the warn threshold), a single summary
 * is emitted with the peak rate and stress duration.
 */
import type { ChildLogger, LogLevel } from "@/api/log-entry-model";

import { logger } from "./logger";

const log = logger.child("server");

// --- Types ---

export interface StressCheckpointConfig {
  /** Max calls per window before logging an error. */
  rate: number;
  /** Window size in milliseconds (default: 1000). */
  windowMs?: number;
  /** Warn threshold as fraction of rate (default: 0.5). */
  warnRatio?: number;
  /** Windows to suppress logs after an error alert (default: 10). */
  cooldownWindows?: number;
}

interface RateCounter {
  count: number;
  windowStart: number;
  warned: boolean;
  alerted: boolean;
  /** Remaining windows to suppress logs. 0 = not in cooldown. */
  cooldownRemaining: number;
  /** Peak count observed during cooldown (for summary). */
  cooldownPeak: number;
  /** Timestamp when cooldown began. */
  cooldownStart: number;
}

interface CheckpointState {
  config: Required<
    Pick<StressCheckpointConfig, "rate" | "windowMs" | "warnRatio" | "cooldownWindows">
  >;
  warnThreshold: number;
  global: RateCounter;
  byParams: Map<string, RateCounter>;
  log: ChildLogger;
}

export interface StressDetector {
  /** Track a checkpoint firing (rate-only mode). */
  track(name: string): void;
  /** Track a checkpoint with params (rate + same-params mode). */
  track(name: string, params: Record<string, unknown>): void;
  /** Clear internal state. Call on shutdown. */
  dispose(): void;
}

// --- Constants ---

const DEFAULT_WINDOW_MS = 1000;
const DEFAULT_WARN_RATIO = 0.5;
const DEFAULT_COOLDOWN_WINDOWS = 10;
const MAX_PARAM_KEYS = 500;

// --- Helpers ---

function createCounter(now: number): RateCounter {
  return {
    count: 0,
    windowStart: now,
    warned: false,
    alerted: false,
    cooldownRemaining: 0,
    cooldownPeak: 0,
    cooldownStart: 0,
  };
}

function resetCounter(counter: RateCounter, now: number): void {
  counter.count = 0;
  counter.windowStart = now;
  counter.warned = false;
  counter.alerted = false;
}

// --- Factory ---

export type LogFn = (
  level: Extract<LogLevel, "warn" | "error">,
  msg: string,
  ctx: Record<string, unknown>,
) => void;

export function createStressDetector(
  checkpoints: Record<string, StressCheckpointConfig>,
  logFn?: LogFn,
): StressDetector {
  const states = new Map<string, CheckpointState>();

  for (const [name, cfg] of Object.entries(checkpoints)) {
    const windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    const warnRatio = cfg.warnRatio ?? DEFAULT_WARN_RATIO;
    const cooldownWindows = cfg.cooldownWindows ?? DEFAULT_COOLDOWN_WINDOWS;
    const childLog = log.with({ checkpoint: name });
    states.set(name, {
      config: { rate: cfg.rate, windowMs, warnRatio, cooldownWindows },
      warnThreshold: Math.floor(cfg.rate * warnRatio),
      global: createCounter(0),
      byParams: new Map(),
      log: logFn
        ? {
            ...childLog,
            warn: (msg, ctx) => logFn("warn", msg, { checkpoint: name, ...ctx }),
            error: (msg, ctx) => logFn("error", msg, { checkpoint: name, ...ctx }),
          }
        : childLog,
    });
  }

  /** Increment counter, check thresholds, return whether the window was reset. */
  function checkCounter(
    counter: RateCounter,
    state: CheckpointState,
    now: number,
    params?: Record<string, unknown>,
  ): boolean {
    // Reset window if elapsed
    let wasReset = false;
    if (now - counter.windowStart >= state.config.windowMs) {
      // Handle cooldown transitions on window boundary
      if (counter.cooldownRemaining > 0) {
        counter.cooldownRemaining--;
        counter.cooldownPeak = Math.max(counter.cooldownPeak, counter.count);

        if (counter.cooldownRemaining === 0) {
          // Cooldown expired — emit summary
          const durationMs = now - counter.cooldownStart;
          const ctx: Record<string, unknown> = {
            peakCount: counter.cooldownPeak,
            threshold: state.config.rate,
            windowMs: state.config.windowMs,
            durationMs,
          };
          if (params) ctx.params = params;
          state.log.warn("[stress] Cooldown ended", ctx);
        }
      }

      resetCounter(counter, now);
      wasReset = true;
    }

    counter.count++;

    // During cooldown, track peak but suppress logs
    if (counter.cooldownRemaining > 0) {
      counter.cooldownPeak = Math.max(counter.cooldownPeak, counter.count);
      return wasReset;
    }

    const ctx: Record<string, unknown> = {
      count: counter.count,
      threshold: state.config.rate,
      windowMs: state.config.windowMs,
    };
    if (params) ctx.params = params;

    if (!counter.warned && counter.count > state.warnThreshold) {
      counter.warned = true;
      state.log.warn("[stress] Elevated call rate", { ...ctx, warnThreshold: state.warnThreshold });
    }

    if (!counter.alerted && counter.count > state.config.rate) {
      counter.alerted = true;
      state.log.error("[stress] High call rate detected", ctx);

      // Enter cooldown
      counter.cooldownRemaining = state.config.cooldownWindows;
      counter.cooldownPeak = counter.count;
      counter.cooldownStart = now;
    }

    return wasReset;
  }

  function track(name: string, params?: Record<string, unknown>): void {
    const state = states.get(name);
    if (!state) return;

    const now = Date.now();

    // Always check global counter
    const globalReset = checkCounter(state.global, state, now);

    // Params mode: also check per-param counter
    if (params) {
      const key = JSON.stringify(params);

      // Clear param counters when the global window rolls over
      if (globalReset && state.byParams.size > 0) {
        state.byParams.clear();
      }

      let paramCounter = state.byParams.get(key);
      if (!paramCounter) {
        if (state.byParams.size >= MAX_PARAM_KEYS) return;
        paramCounter = createCounter(now);
        state.byParams.set(key, paramCounter);
      }
      checkCounter(paramCounter, state, now, params);
    }
  }

  function dispose(): void {
    states.clear();
  }

  return { track, dispose };
}

// --- Default instance ---

export const stress = createStressDetector({
  broadcast: { rate: 50 },
  "fs-flush": { rate: 25 },
  "git-watch": { rate: 25 },
  "status-event": { rate: 10 },
  "agent-event": { rate: 100 },
  "pty-output": { rate: 250 },
  "api-request": { rate: 50 },
  "ts-completions": { rate: 20 },
  "ts-references": { rate: 10 },
  "ts-diagnostics": { rate: 20 },
  diagnostics: { rate: 10 },
});
