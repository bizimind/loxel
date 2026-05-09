/**
 * Electron main process performance monitor.
 *
 * Collects per-process CPU/memory via app.getAppMetrics(), main process
 * memory via process.memoryUsage(), and event loop lag via setTimeout drift.
 * Reports to the server via POST /api/log (same as the frontend logger).
 *
 * Designed for always-on use: polls every 10s for process metrics,
 * probes event loop lag every 2s, and sends one summary per interval.
 */
import { app } from "electron";

import { computeLagStats } from "../lib/perf-lag-stats";

// --- Configuration ---

const METRICS_INTERVAL_MS = 10_000;
const LAG_PROBE_INTERVAL_MS = 2_000;
const LAG_PROBE_EXPECTED_MS = 50;

const HIGH_CPU_THRESHOLD = 80;
const HIGH_MEMORY_MB = 2048;
const HIGH_LAG_MS = 100;

// --- Accumulators ---

const LAG_RING_SIZE = 8;
const lagSamples = new Float64Array(LAG_RING_SIZE);
let lagWriteIdx = 0;
let lagSampleCount = 0;

// --- Helpers ---

function postLog(
  serverUrl: string,
  level: string,
  msg: string,
  ctx: Record<string, unknown>,
): void {
  fetch(`${serverUrl}/api/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, cat: "perf", msg, ctx }),
  }).catch(() => {});
}

// --- Event loop lag probe ---

let lagTimer: ReturnType<typeof setInterval> | undefined;

function probeLag(): void {
  const start = Date.now();
  setTimeout(() => {
    const drift = Date.now() - start - LAG_PROBE_EXPECTED_MS;
    const lag = Math.max(0, drift);
    lagSamples[lagWriteIdx % LAG_RING_SIZE] = lag;
    lagWriteIdx++;
    lagSampleCount++;
  }, LAG_PROBE_EXPECTED_MS);
}

// --- Process metrics ---

interface ProcessSummary {
  type: string;
  cpuPercent: number;
  memoryMB: number;
}

let metricsTimer: ReturnType<typeof setInterval> | undefined;

function collectAndReport(serverUrl: string): void {
  // Per-process metrics from Electron
  const appMetrics = app.getAppMetrics();
  const processes: ProcessSummary[] = appMetrics.map((m) => ({
    type: m.type,
    cpuPercent: Math.round(m.cpu.percentCPUUsage * 100) / 100,
    memoryMB: Math.round(m.memory.workingSetSize / 1024),
  }));

  let totalCpu = 0;
  let totalMemoryMB = 0;
  for (const p of processes) {
    totalCpu += p.cpuPercent;
    totalMemoryMB += p.memoryMB;
  }
  totalCpu = Math.round(totalCpu * 100) / 100;

  // Main process memory details
  const mem = process.memoryUsage();
  const mainMemory = {
    rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
  };

  // Event loop lag
  const lagStats = computeLagStats(lagSamples, lagSampleCount, LAG_RING_SIZE);

  const ctx: Record<string, unknown> = {
    processes,
    total: { cpuPercent: totalCpu, memoryMB: totalMemoryMB },
    mainMemory,
  };
  if (lagStats) ctx.eventLoopLag = lagStats;

  // Emit summary at debug level
  postLog(serverUrl, "debug", "main process metrics", ctx);

  // Escalate anomalies
  for (const p of processes) {
    if (p.cpuPercent > HIGH_CPU_THRESHOLD) {
      postLog(serverUrl, "warn", "high CPU usage", {
        processType: p.type,
        cpuPercent: p.cpuPercent,
      });
    }
  }
  if (totalMemoryMB > HIGH_MEMORY_MB) {
    postLog(serverUrl, "warn", "high total memory", { totalMemoryMB });
  }
  if (lagStats && lagStats.max > HIGH_LAG_MS) {
    postLog(serverUrl, "warn", "main process event loop lag", { ...lagStats });
  }

  // Reset lag accumulators
  lagWriteIdx = 0;
  lagSampleCount = 0;
}

// --- Public API ---

/**
 * Start the main process performance monitor. Returns a cleanup function.
 * Call after app.whenReady() in main.ts.
 *
 * @param serverUrl - The loxel server base URL (e.g. "http://127.0.0.1:7433")
 */
export function startMainProcessMonitor(serverUrl: string): () => void {
  lagTimer = setInterval(probeLag, LAG_PROBE_INTERVAL_MS);
  metricsTimer = setInterval(() => collectAndReport(serverUrl), METRICS_INTERVAL_MS);

  return () => {
    if (lagTimer !== undefined) clearInterval(lagTimer);
    if (metricsTimer !== undefined) clearInterval(metricsTimer);
  };
}
