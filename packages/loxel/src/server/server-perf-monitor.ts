/**
 * Server-side (Bun) continuous performance monitor.
 *
 * Measures event loop lag via setTimeout drift and memory via
 * process.memoryUsage(). Reports through the server logger at debug level.
 * Follows the stress-detector.ts disposable pattern.
 */
import { computeLagStats } from "@/lib/perf-lag-stats";

import { logger } from "./logger";

const log = logger.child("perf");

// --- Configuration ---

const SUMMARY_INTERVAL_MS = 10_000;
const LAG_PROBE_INTERVAL_MS = 2_000;
const LAG_PROBE_EXPECTED_MS = 50;

const HIGH_LAG_MS = 100;
const HIGH_RSS_MB = 1024;

// --- Accumulators ---

const LAG_RING_SIZE = 8;
const lagSamples = new Float64Array(LAG_RING_SIZE);
let lagWriteIdx = 0;
let lagSampleCount = 0;

// --- Event loop lag probe ---

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

// --- Summary ---

function collectAndReport(): void {
  const mem = process.memoryUsage();
  const memory = {
    rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
  };

  const lagStats = computeLagStats(lagSamples, lagSampleCount, LAG_RING_SIZE);

  const ctx: Record<string, unknown> = { memory };
  if (lagStats) ctx.eventLoopLag = lagStats;

  log.debug("server metrics", ctx);

  // Escalate anomalies
  if (lagStats && lagStats.max > HIGH_LAG_MS) {
    log.warn("server event loop lag", { ...lagStats });
  }
  if (memory.rssMB > HIGH_RSS_MB) {
    log.warn("high server memory", memory);
  }

  // Reset lag accumulators
  lagWriteIdx = 0;
  lagSampleCount = 0;
}

// --- Public API ---

export function createServerPerfMonitor(): { dispose(): void } {
  const lagTimer = setInterval(probeLag, LAG_PROBE_INTERVAL_MS);
  const summaryTimer = setInterval(collectAndReport, SUMMARY_INTERVAL_MS);

  return {
    dispose() {
      clearInterval(lagTimer);
      clearInterval(summaryTimer);
    },
  };
}
