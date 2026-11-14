/**
 * The terminal host's perf monitor: its event loop lag, memory, PTY spawns and what its sessions
 * hold, summed up every {@link HOST_PERF_SUMMARY_INTERVAL_MS} as a `debug` line of category `perf`,
 * which the host forwards to its server next to the server's own metrics, and anomalies at `warn`.
 * One host serves every session of a build, so its stalls and its growth reach every terminal at
 * once. Nothing here runs on the output path: the lag probe is one timer, a PTY spawn adds a few
 * numbers, and the sessions are read once per summary. See docs/TERMINAL_HOST.md#logs.
 */
import type { ChildLogger } from "@/api/log-entry-model";
import { computeLagStats } from "@/lib/perf-lag-stats";

import type { HostedSessionStats } from "./in-process-terminal-host";

export const HOST_PERF_SUMMARY_INTERVAL_MS = 30_000;
/**
 * The lag probe re-arms itself every tick, so a stall at any point in the window delays the timer
 * waiting through it, rather than only one that starts inside a short probe window.
 */
const LAG_PROBE_MS = 100;
const LAG_RING_SIZE = Math.ceil(HOST_PERF_SUMMARY_INTERVAL_MS / LAG_PROBE_MS);
/** A window whose longest stall passes this is logged as a warning. */
const HIGH_LAG_MS = 100;
/** Past this RSS, every new step of {@link RSS_STEP_MB} reached is logged as a warning, once. */
const HIGH_RSS_MB = 1024;
const RSS_STEP_MB = 512;

export interface HostPerfMonitorOptions {
  /** The host's logger of category `perf`. */
  log: ChildLogger;
  sessions: () => HostedSessionStats;
  /** Replace the clock and the memory reading, for tests. */
  now?: () => number;
  memory?: () => { rss: number; heapUsed: number };
}

function megabytes(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export class HostPerfMonitor {
  private readonly log: ChildLogger;
  private readonly now: () => number;
  private readonly memory: () => { rss: number; heapUsed: number };
  private readonly lagSamples = new Float64Array(LAG_RING_SIZE);
  private lagSampleCount = 0;
  private stalledMs = 0;
  private spawns = 0;
  private spawnBlockTotalMs = 0;
  private spawnBlockMaxMs = 0;
  /** The highest RSS step warned about. */
  private warnedRssMB = 0;
  private probe: ReturnType<typeof setTimeout> | null = null;
  private summary: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostPerfMonitorOptions) {
    this.log = options.log;
    this.now = options.now ?? (() => performance.now());
    this.memory = options.memory ?? (() => process.memoryUsage());
  }

  start(): void {
    if (this.summary) return;
    this.armProbe();
    this.summary = setInterval(() => this.report(), HOST_PERF_SUMMARY_INTERVAL_MS);
    this.summary.unref();
  }

  dispose(): void {
    if (this.probe) clearTimeout(this.probe);
    if (this.summary) clearInterval(this.summary);
    this.probe = null;
    this.summary = null;
  }

  /**
   * Run `spawn`, a PTY's synchronous `Bun.spawn`, and count it: macOS serialises process creation
   * system-wide, so the time it blocks the host depends on what the rest of the machine spawns.
   */
  measureSpawn<T>(spawn: () => T): T {
    const start = this.now();
    try {
      return spawn();
    } finally {
      const blockMs = this.now() - start;
      this.spawns++;
      this.spawnBlockTotalMs += blockMs;
      this.spawnBlockMaxMs = Math.max(this.spawnBlockMaxMs, blockMs);
    }
  }

  /** Log the window's summary, and its anomalies, then start the next window. */
  report(): void {
    const mem = this.memory();
    const memory = { rssMB: megabytes(mem.rss), heapUsedMB: megabytes(mem.heapUsed) };
    const lag = computeLagStats(this.lagSamples, this.lagSampleCount, LAG_RING_SIZE);
    const eventLoopLag = lag && { ...lag, stalledMs: round(this.stalledMs) };
    const ptySpawns = {
      count: this.spawns,
      blockMs: { total: round(this.spawnBlockTotalMs), max: round(this.spawnBlockMaxMs) },
    };
    const { running, ended, ringBytes, bufferLines } = this.options.sessions();
    const sessions = { running, ended, ringMB: megabytes(ringBytes), bufferLines };

    this.log.debug("terminal host metrics", { memory, eventLoopLag, ptySpawns, sessions });
    if (eventLoopLag && eventLoopLag.max > HIGH_LAG_MS) {
      this.log.warn("terminal host event loop lag", { ...eventLoopLag, ptySpawns, sessions });
    }
    const rssStepMB = Math.floor(memory.rssMB / RSS_STEP_MB) * RSS_STEP_MB;
    if (memory.rssMB >= HIGH_RSS_MB && rssStepMB > this.warnedRssMB) {
      this.warnedRssMB = rssStepMB;
      this.log.warn(`high terminal host memory: past ${rssStepMB} MB`, { ...memory, sessions });
    }

    this.lagSampleCount = 0;
    this.stalledMs = 0;
    this.spawns = 0;
    this.spawnBlockTotalMs = 0;
    this.spawnBlockMaxMs = 0;
  }

  private armProbe(): void {
    const due = this.now() + LAG_PROBE_MS;
    this.probe = setTimeout(() => {
      const lag = Math.max(0, this.now() - due);
      this.lagSamples[this.lagSampleCount % LAG_RING_SIZE] = lag;
      this.lagSampleCount++;
      this.stalledMs += lag;
      this.armProbe();
    }, LAG_PROBE_MS);
    this.probe.unref();
  }
}
