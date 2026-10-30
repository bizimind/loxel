/**
 * Stress detection for critical paths.
 *
 * Monitors call rates at named checkpoints and logs when thresholds are exceeded. Detection
 * only — no throttling or corrective action.
 *
 * Two modes:
 * - Rate-only: detects when a checkpoint fires above a configured rate.
 * - Rate + key: also detects when the same key (a string identifying the parameters) fires above
 *   the configured rate (loop detection).
 *
 * Logs transitions, not windows: a counter logs when it enters an episode (warn above the warn
 * threshold), when it escalates within one (error above the rate), and once when the episode ends
 * with a summary of its peak and duration. An episode ends after `calmWindows` consecutive windows
 * at or below the warn threshold, so a bursty rate is one episode rather than a stream of logs. A
 * timer closes windows while any episode is open, because a rate that drops to zero has no further
 * calls to notice that with.
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
  /** Consecutive windows at or below the warn threshold that end an episode (default: 10). */
  calmWindows?: number;
}

interface Episode {
  level: "elevated" | "high";
  start: number;
  /** When the count last went above the warn threshold, which is when the episode really ended. */
  lastHotAt: number;
  peakCount: number;
  calmStreak: number;
}

interface RateCounter {
  key: string | undefined;
  count: number;
  windowStart: number;
  episode: Episode | null;
}

interface CheckpointState {
  config: Required<Pick<StressCheckpointConfig, "rate" | "windowMs" | "warnRatio" | "calmWindows">>;
  warnThreshold: number;
  global: RateCounter;
  byKey: Map<string, RateCounter>;
  log: ChildLogger;
}

export interface StressDetector {
  /** Track a checkpoint firing, optionally for a key identifying its parameters. */
  track(name: string, key?: string): void;
  /** Close elapsed windows, ending episodes that have calmed down. */
  sweep(): void;
  /** Clear internal state. Call on shutdown. */
  dispose(): void;
}

export interface StressDetectorOptions {
  logFn?: LogFn;
  /** The clock, in milliseconds. */
  now?: () => number;
}

// --- Constants ---

const DEFAULT_WINDOW_MS = 1000;
const DEFAULT_WARN_RATIO = 0.5;
const DEFAULT_CALM_WINDOWS = 10;
const MAX_PARAM_KEYS = 500;
const SWEEP_INTERVAL_MS = 1000;

// --- Helpers ---

function createCounter(now: number, key?: string): RateCounter {
  return { key, count: 0, windowStart: now, episode: null };
}

// --- Factory ---

export type LogFn = (
  level: Extract<LogLevel, "warn" | "error">,
  msg: string,
  ctx: Record<string, unknown>,
) => void;

export function createStressDetector(
  checkpoints: Record<string, StressCheckpointConfig>,
  { logFn, now = Date.now }: StressDetectorOptions = {},
): StressDetector {
  const states = new Map<string, CheckpointState>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  for (const [name, cfg] of Object.entries(checkpoints)) {
    const windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    const warnRatio = cfg.warnRatio ?? DEFAULT_WARN_RATIO;
    const calmWindows = cfg.calmWindows ?? DEFAULT_CALM_WINDOWS;
    const childLog = log.with({ checkpoint: name });
    states.set(name, {
      config: { rate: cfg.rate, windowMs, warnRatio, calmWindows },
      warnThreshold: Math.floor(cfg.rate * warnRatio),
      global: createCounter(0),
      byKey: new Map(),
      log: logFn
        ? {
            ...childLog,
            warn: (msg, ctx) => logFn("warn", msg, { checkpoint: name, ...ctx }),
            error: (msg, ctx) => logFn("error", msg, { checkpoint: name, ...ctx }),
          }
        : childLog,
    });
  }

  /** Account for the windows that have ended by `time`; returns whether any had. */
  function closeWindows(counter: RateCounter, state: CheckpointState, time: number): boolean {
    const { windowMs, calmWindows, rate } = state.config;
    const elapsed = Math.floor((time - counter.windowStart) / windowMs);
    if (elapsed < 1) return false;

    const { episode } = counter;
    if (episode) {
      // Windows with no calls at all are calm too, hence the rest of `elapsed`.
      const calm = counter.count > state.warnThreshold ? elapsed - 1 : elapsed;
      episode.calmStreak = calm === elapsed ? episode.calmStreak + calm : calm;
      if (episode.calmStreak >= calmWindows) {
        const ctx: Record<string, unknown> = {
          level: episode.level,
          peakCount: episode.peakCount,
          threshold: rate,
          windowMs,
          durationMs: episode.lastHotAt - episode.start,
        };
        if (counter.key !== undefined) ctx.key = counter.key;
        state.log.warn("[stress] Call rate back to normal", ctx);
        counter.episode = null;
      }
    }

    counter.count = 0;
    counter.windowStart += elapsed * windowMs;
    return true;
  }

  function logEntry(
    counter: RateCounter,
    state: CheckpointState,
    level: "warn" | "error",
    msg: string,
  ): void {
    const ctx: Record<string, unknown> = {
      count: counter.count,
      threshold: state.config.rate,
      windowMs: state.config.windowMs,
    };
    if (level === "warn") ctx.warnThreshold = state.warnThreshold;
    if (counter.key !== undefined) ctx.key = counter.key;
    state.log[level](msg, ctx);
  }

  /** Count one call and log any state change it causes. */
  function count(counter: RateCounter, state: CheckpointState, time: number): void {
    counter.count++;
    if (counter.count <= state.warnThreshold) return;

    if (!counter.episode) {
      counter.episode = {
        level: "elevated",
        start: time,
        lastHotAt: time,
        peakCount: counter.count,
        calmStreak: 0,
      };
      logEntry(counter, state, "warn", "[stress] Elevated call rate");
      startSweeping();
    }

    const { episode } = counter;
    episode.lastHotAt = time;
    episode.peakCount = Math.max(episode.peakCount, counter.count);
    if (episode.level === "elevated" && counter.count > state.config.rate) {
      episode.level = "high";
      logEntry(counter, state, "error", "[stress] High call rate detected");
    }
  }

  function track(name: string, key?: string): void {
    const state = states.get(name);
    if (!state) return;

    const time = now();
    const globalRolled = closeWindows(state.global, state, time);
    count(state.global, state, time);
    if (key === undefined) return;

    // Key counters only need to outlive the window while they have an episode to finish.
    if (globalRolled) closeKeyWindows(state, time);

    let counter = state.byKey.get(key);
    if (!counter) {
      if (state.byKey.size >= MAX_PARAM_KEYS) return;
      counter = createCounter(time, key);
      state.byKey.set(key, counter);
    } else {
      closeWindows(counter, state, time);
    }
    count(counter, state, time);
  }

  function closeKeyWindows(state: CheckpointState, time: number): void {
    for (const [key, counter] of state.byKey) {
      closeWindows(counter, state, time);
      if (!counter.episode) state.byKey.delete(key);
    }
  }

  function startSweeping(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }

  function stopSweeping(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function sweep(): void {
    const time = now();
    let open = false;
    for (const state of states.values()) {
      closeWindows(state.global, state, time);
      closeKeyWindows(state, time);
      if (state.global.episode || state.byKey.size > 0) open = true;
    }
    if (!open) stopSweeping();
  }

  function dispose(): void {
    stopSweeping();
    states.clear();
  }

  return { track, sweep, dispose };
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
