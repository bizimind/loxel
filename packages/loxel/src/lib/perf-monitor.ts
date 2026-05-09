/**
 * Renderer-side continuous performance monitor.
 *
 * Collects FPS, long tasks, event loop lag, and JS heap metrics using
 * browser-native APIs. Aggregates into periodic summaries emitted via
 * the frontend logger at debug level (file + ring buffer, no WS broadcast).
 * Anomalies (severe long tasks, sustained jank) escalate to warn/error.
 *
 * Designed for always-on use with negligible overhead:
 * - rAF counter: one integer increment per frame
 * - PerformanceObserver: passive, zero cost when idle
 * - MessageChannel lag probe: one round-trip every 2s
 * - Memory read: one property access every 10s
 * - Summary flush: one small HTTP POST every 5s
 */
import { frontendLog } from "./frontend-logger";
import { computeLagStats } from "./perf-lag-stats";

const log = frontendLog.child("perf");

// --- Configuration ---

const SUMMARY_INTERVAL_MS = 5_000;
const LAG_PROBE_INTERVAL_MS = 2_000;
const MEMORY_SAMPLE_INTERVAL_MS = 10_000;

const LONG_TASK_WARN_MS = 200;
const LONG_TASK_ERROR_MS = 500;
const LOW_FPS_THRESHOLD = 20;
const HIGH_HEAP_MB = 1024;

// --- Accumulators (module-level, no per-sample allocations) ---

let frameCount = 0;
let summaryStart = 0;
let minFps = Infinity;
let fpsWindowStart = 0;
let fpsWindowFrames = 0;

let longTaskCount = 0;
let longTaskTotalMs = 0;

const LAG_RING_SIZE = 16;
const lagSamples = new Float64Array(LAG_RING_SIZE);
let lagWriteIdx = 0;
let lagSampleCount = 0;

let lastUsedHeapMB = 0;
let lastTotalHeapMB = 0;
let lastHeapLimitMB = 0;

// --- Chrome-only performance.memory type ---

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function getPerformanceMemory(): PerformanceMemory | null {
  const perf = performance as { memory?: PerformanceMemory };
  return perf.memory ?? null;
}

// --- Helpers ---

function resetAccumulators(): void {
  frameCount = 0;
  summaryStart = performance.now();
  minFps = Infinity;
  fpsWindowStart = performance.now();
  fpsWindowFrames = 0;
  longTaskCount = 0;
  longTaskTotalMs = 0;
  lagWriteIdx = 0;
  lagSampleCount = 0;
}

// --- FPS tracking via requestAnimationFrame ---

let rafId = 0;

function onFrame(): void {
  frameCount++;
  fpsWindowFrames++;

  const now = performance.now();
  const windowElapsed = now - fpsWindowStart;
  // Compute per-second FPS snapshots
  if (windowElapsed >= 1000) {
    const fps = (fpsWindowFrames / windowElapsed) * 1000;
    if (fps < minFps) minFps = fps;
    fpsWindowFrames = 0;
    fpsWindowStart = now;
  }

  rafId = requestAnimationFrame(onFrame);
}

// --- Long task observer ---

function setupLongTaskObserver(): PerformanceObserver | null {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const durationMs = entry.duration;
        longTaskCount++;
        longTaskTotalMs += durationMs;

        // Escalate severe long tasks immediately
        if (durationMs >= LONG_TASK_ERROR_MS) {
          log.error("long task", { durationMs: Math.round(durationMs) });
        } else if (durationMs >= LONG_TASK_WARN_MS) {
          log.warn("long task", { durationMs: Math.round(durationMs) });
        }
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    return observer;
  } catch {
    // longtask not supported in this environment
    return null;
  }
}

// --- Event loop lag via MessageChannel ---

let lagProbeTimer: ReturnType<typeof setInterval> | undefined;
let lagChannel: MessageChannel | null = null;
let lagProbeStart = 0;

function setupLagProbe(): void {
  lagChannel = new MessageChannel();
  lagChannel.port1.onmessage = () => {
    const lag = performance.now() - lagProbeStart;
    lagSamples[lagWriteIdx % LAG_RING_SIZE] = lag;
    lagWriteIdx++;
    lagSampleCount++;
  };

  lagProbeTimer = setInterval(() => {
    lagProbeStart = performance.now();
    lagChannel!.port2.postMessage(null);
  }, LAG_PROBE_INTERVAL_MS);
}

// --- Memory sampling ---

let memoryTimer: ReturnType<typeof setInterval> | undefined;

function setupMemorySampler(): void {
  function sample(): void {
    const mem = getPerformanceMemory();
    if (!mem) return;
    lastUsedHeapMB = Math.round((mem.usedJSHeapSize / 1024 / 1024) * 10) / 10;
    lastTotalHeapMB = Math.round((mem.totalJSHeapSize / 1024 / 1024) * 10) / 10;
    lastHeapLimitMB = Math.round((mem.jsHeapSizeLimit / 1024 / 1024) * 10) / 10;
  }

  // Take an initial sample
  sample();
  memoryTimer = setInterval(sample, MEMORY_SAMPLE_INTERVAL_MS);
}

// --- Summary flush ---

let summaryTimer: ReturnType<typeof setInterval> | undefined;

function flush(): void {
  const now = performance.now();
  const elapsed = now - summaryStart;
  if (elapsed < 100) return; // guard against flush before any data

  const avgFps = Math.round((frameCount / elapsed) * 1000);
  const roundedMinFps = minFps === Infinity ? avgFps : Math.round(minFps);

  const ctx: Record<string, unknown> = { fps: { avg: avgFps, min: roundedMinFps } };

  if (longTaskCount > 0) {
    ctx.longTasks = { count: longTaskCount, totalMs: Math.round(longTaskTotalMs) };
  }

  const lagStats = computeLagStats(lagSamples, lagSampleCount, LAG_RING_SIZE);
  if (lagStats) {
    ctx.eventLoopLag = lagStats;
  }

  if (lastUsedHeapMB > 0) {
    ctx.memory = { usedMB: lastUsedHeapMB, totalMB: lastTotalHeapMB, limitMB: lastHeapLimitMB };
  }

  // Emit summary at debug level (file + ring buffer only, no WS broadcast)
  log.debug("renderer metrics", ctx);

  // Escalate sustained anomalies
  if (avgFps < LOW_FPS_THRESHOLD && avgFps > 0) {
    log.warn("low FPS", { avgFps, minFps: roundedMinFps });
  }
  if (lastUsedHeapMB > HIGH_HEAP_MB) {
    log.warn("high heap usage", { usedMB: lastUsedHeapMB, totalMB: lastTotalHeapMB });
  }

  resetAccumulators();
}

// --- Public API ---

/**
 * Start the renderer performance monitor. Returns a cleanup function.
 * Call once at app init (e.g. from main.tsx).
 */
export function startPerfMonitor(): () => void {
  resetAccumulators();

  // FPS
  rafId = requestAnimationFrame(onFrame);

  // Long tasks
  const longTaskObserver = setupLongTaskObserver();

  // Event loop lag
  setupLagProbe();

  // Memory
  setupMemorySampler();

  // Summary
  summaryTimer = setInterval(flush, SUMMARY_INTERVAL_MS);

  return () => {
    cancelAnimationFrame(rafId);
    longTaskObserver?.disconnect();
    if (lagProbeTimer !== undefined) clearInterval(lagProbeTimer);
    if (lagChannel) {
      lagChannel.port1.close();
      lagChannel.port2.close();
      lagChannel = null;
    }
    if (memoryTimer !== undefined) clearInterval(memoryTimer);
    if (summaryTimer !== undefined) clearInterval(summaryTimer);
  };
}
