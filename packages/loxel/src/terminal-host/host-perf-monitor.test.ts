import { afterEach, describe, expect, jest, test } from "bun:test";

import { createNoopLogger } from "@bizimind/logger";

import { HOST_PERF_SUMMARY_INTERVAL_MS, HostPerfMonitor } from "./host-perf-monitor";

const MB = 1024 * 1024;

afterEach(() => {
  jest.useRealTimers();
});

/** A monitor on a clock the test moves, logging into `lines`. */
function createMonitor(rssMB = 200) {
  const lines: { level: string; msg: string; ctx?: Record<string, unknown> }[] = [];
  const record = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    lines.push({ level, msg, ctx });
  };
  const clock = { now: 0, wall: 1_000_000 };
  const memory = { rss: rssMB * MB, heapUsed: 50 * MB };
  const monitor = new HostPerfMonitor({
    log: {
      ...createNoopLogger(),
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    sessions: () => ({ running: 3, ended: 1, ringBytes: 2 * MB, bufferLines: 4200 }),
    clocks: { awake: () => clock.now, wall: () => clock.wall + clock.now },
    memory: () => memory,
  });
  return { monitor, lines, clock, memory };
}

describe("HostPerfMonitor", () => {
  test("sums up the window: a stall anywhere in it, PTY spawns, memory and the sessions", () => {
    jest.useFakeTimers();
    const { monitor, lines, clock } = createMonitor();
    monitor.start();
    // Three on-time ticks, then one held up by a 350 ms stall, wherever in the tick it fell.
    for (const late of [0, 0, 0, 350]) {
      clock.now += 100 + late;
      jest.advanceTimersByTime(100);
    }
    monitor.measureSpawn(() => {
      clock.now += 12;
    });
    monitor.report();
    monitor.dispose();

    expect(lines[0]).toEqual({
      level: "debug",
      msg: "terminal host metrics",
      ctx: {
        memory: { rssMB: 200, heapUsedMB: 50 },
        eventLoopLag: { avg: 87.5, max: 350, stalledMs: 350 },
        ptySpawns: { count: 1, blockMs: { total: 12, max: 12 } },
        sessions: { running: 3, ended: 1, ringMB: 2, bufferLines: 4200 },
      },
    });
    expect(lines.slice(1).map((line) => [line.level, line.msg])).toEqual([
      ["warn", "terminal host event loop lag"],
    ]);
  });

  test("reports every summary interval, each window on its own", () => {
    jest.useFakeTimers();
    const { monitor, lines, clock } = createMonitor();
    monitor.start();
    monitor.measureSpawn(() => {});
    for (let elapsed = 0; elapsed < HOST_PERF_SUMMARY_INTERVAL_MS * 2; elapsed += 100) {
      clock.now += 100;
      jest.advanceTimersByTime(100);
    }
    monitor.dispose();
    const summaries = lines.filter((line) => line.msg === "terminal host metrics");
    expect(summaries.map((line) => line.ctx?.ptySpawns)).toEqual([
      { count: 1, blockMs: { total: 0, max: 0 } },
      { count: 0, blockMs: { total: 0, max: 0 } },
    ]);
    expect(lines.some((line) => line.level === "warn")).toBe(false);
  });

  test("warns once for each new step of memory past 1 GB", () => {
    const { monitor, lines, memory } = createMonitor(900);
    const warnings = () => lines.filter((line) => line.level === "warn").map((line) => line.msg);
    monitor.report();
    expect(warnings()).toEqual([]);
    memory.rss = 1100 * MB;
    monitor.report();
    monitor.report();
    memory.rss = 1600 * MB;
    monitor.report();
    expect(warnings()).toEqual([
      "high terminal host memory: past 1024 MB",
      "high terminal host memory: past 1536 MB",
    ]);
  });

  test("a tick the machine slept through is sleep, not lag", () => {
    jest.useFakeTimers();
    const { monitor, lines, clock } = createMonitor();
    monitor.start();
    clock.now += 100;
    jest.advanceTimersByTime(100);
    // Asleep for an hour: the wall clock moved on, the monotonic clock did not; the timer fires
    // late on wake, as the event loop runs its due timers first.
    clock.wall += 3_600_000;
    clock.now += 100 + 400;
    jest.advanceTimersByTime(100);
    monitor.report();
    monitor.dispose();
    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      ["debug", "terminal host metrics"],
    ]);
    expect(lines[0]!.ctx).toMatchObject({
      eventLoopLag: { max: 0, stalledMs: 0 },
      sleptMs: 3_600_000,
    });
  });
});
