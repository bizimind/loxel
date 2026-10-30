/**
 * Accounting for the subprocesses the server starts, reported next to the event loop lag warning
 * (server-perf-monitor.ts) so a stall shows how much spawning happened in the same window.
 *
 * `Bun.spawn` forks and execs synchronously on the calling thread, and macOS serialises process
 * creation system-wide, so the time a spawn blocks its caller depends on what the rest of the
 * machine is spawning. Recording is one map lookup and a few additions per spawn.
 */

const TOP_LABELS = 5;

interface LabelTotals {
  count: number;
  blockMs: number;
  wallMs: number;
}

export interface SpawnStats {
  windowMs: number;
  spawns: number;
  spawnsPerSec: number;
  /** Synchronous time the spawn calls blocked their caller. */
  blockMs: { total: number; max: number };
  /** Child run time, for the spawns that report one (see {@link recordSpawn}). */
  childWallMs: { total: number; max: number };
  /** The labels with the most spawns in the window, most first. */
  top: Array<LabelTotals & { label: string }>;
}

let totals = new Map<string, LabelTotals>();
let spawns = 0;
let blockTotalMs = 0;
let blockMaxMs = 0;
let wallTotalMs = 0;
let wallMaxMs = 0;
let windowStart = performance.now();

/**
 * Count one spawn. `label` must be a fixed name such as a git subcommand, never paths or arguments.
 *
 * `wallMs` is for short-lived commands, which are recorded when they finish. Long-lived children
 * (language servers, terminals) are recorded when started and leave it out.
 */
export function recordSpawn(label: string, blockMs: number, wallMs = 0): void {
  spawns++;
  blockTotalMs += blockMs;
  blockMaxMs = Math.max(blockMaxMs, blockMs);
  wallTotalMs += wallMs;
  wallMaxMs = Math.max(wallMaxMs, wallMs);

  const entry = totals.get(label);
  if (entry) {
    entry.count++;
    entry.blockMs += blockMs;
    entry.wallMs += wallMs;
  } else {
    totals.set(label, { count: 1, blockMs, wallMs });
  }
}

/** Run `spawn`, a synchronous `Bun.spawn` or `Bun.spawnSync` call, and count it. */
export function measureSpawn<T>(label: string, spawn: () => T): T {
  const start = performance.now();
  try {
    return spawn();
  } finally {
    recordSpawn(label, performance.now() - start);
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** The totals since the previous drain. Starts the next window. */
export function drainSpawnStats(now = performance.now()): SpawnStats {
  const windowMs = now - windowStart;
  const stats: SpawnStats = {
    windowMs: Math.round(windowMs),
    spawns,
    spawnsPerSec: windowMs > 0 ? round((spawns / windowMs) * 1000) : 0,
    blockMs: { total: round(blockTotalMs), max: round(blockMaxMs) },
    childWallMs: { total: round(wallTotalMs), max: round(wallMaxMs) },
    top: [...totals]
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, TOP_LABELS)
      .map(([label, entry]) => ({
        label,
        count: entry.count,
        blockMs: round(entry.blockMs),
        wallMs: round(entry.wallMs),
      })),
  };

  totals = new Map();
  spawns = 0;
  blockTotalMs = 0;
  blockMaxMs = 0;
  wallTotalMs = 0;
  wallMaxMs = 0;
  windowStart = now;
  return stats;
}
