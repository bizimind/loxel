import { describe, expect, test } from "bun:test";

import type { LogFn } from "./stress-detector";
import { createStressDetector } from "./stress-detector";

interface LogCall {
  level: "warn" | "error";
  msg: string;
  ctx: Record<string, unknown>;
}

function setup(checkpoints: Parameters<typeof createStressDetector>[0]) {
  const logs: LogCall[] = [];
  const logFn: LogFn = (level, msg, ctx) => logs.push({ level, msg, ctx });
  const detector = createStressDetector(checkpoints, logFn);
  return { detector, logs };
}

describe("stress-detector", () => {
  test("track on unknown checkpoint is a no-op", () => {
    const { detector, logs } = setup({ known: { rate: 5 } });
    detector.track("unknown");
    detector.track("unknown", { foo: 1 });
    expect(logs).toHaveLength(0);
    detector.dispose();
  });

  test("rate-only: no logs below warn threshold", () => {
    const { detector, logs } = setup({ test: { rate: 10, windowMs: 60_000 } });
    // warnThreshold = floor(10 * 0.5) = 5
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(0);
    detector.dispose();
  });

  test("rate-only: warn at 50%, error at 100%", () => {
    const { detector, logs } = setup({ test: { rate: 10, windowMs: 60_000 } });
    // warnThreshold = 5, error threshold = 10
    for (let i = 0; i < 11; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(2);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.msg).toContain("[stress]");
    expect(logs[0]!.ctx.count).toBe(6); // first call > 5
    expect(logs[0]!.ctx.warnThreshold).toBe(5);

    expect(logs[1]!.level).toBe("error");
    expect(logs[1]!.ctx.count).toBe(11); // first call > 10
    expect(logs[1]!.ctx.threshold).toBe(10);
    detector.dispose();
  });

  test("alerts only once per window", () => {
    const { detector, logs } = setup({ test: { rate: 5, windowMs: 60_000 } });
    for (let i = 0; i < 20; i++) {
      detector.track("test");
    }
    // Should have exactly 1 warn + 1 error, not repeated
    expect(logs).toHaveLength(2);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[1]!.level).toBe("error");
    detector.dispose();
  });

  test("rate+params: different params are independent", () => {
    const { detector, logs } = setup({ test: { rate: 10, windowMs: 60_000 } });
    const paramsA = { type: "a" };
    const paramsB = { type: "b" };

    // 4 calls each — below per-param warn threshold (5) but global is 8
    for (let i = 0; i < 4; i++) {
      detector.track("test", paramsA);
      detector.track("test", paramsB);
    }
    // Global: 8 calls > warn(5), no error(10). Per-param: 4 each < warn(5).
    // So: 1 global warn only.
    const warns = logs.filter((l) => l.level === "warn");
    const errors = logs.filter((l) => l.level === "error");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.ctx.params).toBeUndefined(); // global counter has no params
    expect(errors).toHaveLength(0);
    detector.dispose();
  });

  test("rate+params: identical params trigger per-param alert", () => {
    const { detector, logs } = setup({ test: { rate: 5, windowMs: 60_000 } });
    const params = { type: "loop" };

    for (let i = 0; i < 8; i++) {
      detector.track("test", params);
    }
    // Both global and per-param should have warn + error = 4 total logs
    const warns = logs.filter((l) => l.level === "warn");
    const errors = logs.filter((l) => l.level === "error");
    expect(warns).toHaveLength(2); // global warn + param warn
    expect(errors).toHaveLength(2); // global error + param error

    // Param logs should include the params context
    const paramLogs = logs.filter((l) => l.ctx.params !== undefined);
    expect(paramLogs).toHaveLength(2); // param warn + param error
    expect(paramLogs[0]!.ctx.params).toEqual({ type: "loop" });
    detector.dispose();
  });

  test("window reset clears counters and allows new alerts (no cooldown)", async () => {
    // cooldownWindows: 0 disables cooldown so alerts fire again in next window
    const { detector, logs } = setup({ test: { rate: 3, windowMs: 1, cooldownWindows: 0 } });

    // Exceed threshold — should get warn + error
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(2);

    // Wait for window to elapse
    await Bun.sleep(5);

    // New window — should be able to alert again
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(4); // 2 from first window + 2 from second
    detector.dispose();
  });

  test("custom warnRatio", () => {
    const { detector, logs } = setup({ test: { rate: 10, windowMs: 60_000, warnRatio: 0.3 } });
    // warnThreshold = floor(10 * 0.3) = 3
    for (let i = 0; i < 4; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.ctx.warnThreshold).toBe(3);
    detector.dispose();
  });

  test("param cap prevents unbounded growth", () => {
    const { detector, logs } = setup({ test: { rate: 1000, windowMs: 60_000 } });

    // Create 600 unique param sets — should cap at 500 internal entries
    for (let i = 0; i < 600; i++) {
      detector.track("test", { id: i });
    }
    // Should not OOM or throw. Global still tracks all 600 calls (warn at 501).
    const globalWarn = logs.find((l) => l.level === "warn" && !l.ctx.params);
    expect(globalWarn).toBeDefined();
    detector.dispose();
  });

  test("dispose makes subsequent tracks no-ops", () => {
    const { detector, logs } = setup({ test: { rate: 5, windowMs: 60_000 } });
    detector.dispose();
    for (let i = 0; i < 20; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(0);
  });

  test("multiple checkpoints are independent", () => {
    const { detector, logs } = setup({
      a: { rate: 3, windowMs: 60_000 },
      b: { rate: 100, windowMs: 60_000 },
    });

    for (let i = 0; i < 5; i++) {
      detector.track("a");
      detector.track("b");
    }
    // 'a' should have warn + error (5 > 3), 'b' should have nothing (5 < 50 warn)
    const aLogs = logs.filter((l) => l.ctx.checkpoint === "a");
    const bLogs = logs.filter((l) => l.ctx.checkpoint === "b");
    expect(aLogs).toHaveLength(2);
    expect(bLogs).toHaveLength(0);
    detector.dispose();
  });

  // --- Cooldown tests ---

  test("cooldown suppresses logs after error alert", async () => {
    // cooldownWindows: 2 — suppress for 2 windows after error
    // Use 50ms windows (not 1ms) so the track loop never straddles a window boundary on slow CI
    const { detector, logs } = setup({ test: { rate: 3, windowMs: 50, cooldownWindows: 2 } });

    // Window 1: exceed threshold → warn + error, enters cooldown (remaining=2)
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(2);

    // Window 2: cooldown decrements 2→1, logs suppressed
    await Bun.sleep(60);
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }
    expect(logs).toHaveLength(2); // still 2, cooldown suppressed

    // Window 3: cooldown decrements 1→0, summary emitted, then new alerts fire
    await Bun.sleep(60);
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }
    const summaryLogs = logs.filter((l) => l.msg.includes("Cooldown ended"));
    expect(summaryLogs).toHaveLength(1);
    expect(summaryLogs[0]!.ctx.peakCount).toBeGreaterThan(0);
    expect(summaryLogs[0]!.ctx.durationMs).toBeGreaterThan(0);
    // summary + new warn + new error = 3 new logs
    expect(logs).toHaveLength(5); // 2 original + 1 summary + 2 new alerts
    detector.dispose();
  });

  test("cooldown tracks peak count across suppressed windows", async () => {
    // cooldownWindows: 2 so we get a full suppressed window to observe peak
    // Use 50ms windows (not 1ms) so the track loop never straddles a window boundary on slow CI
    const { detector, logs } = setup({ test: { rate: 3, windowMs: 50, cooldownWindows: 2 } });

    // Window 1: trigger error with 5 calls → cooldown starts, peak=5
    for (let i = 0; i < 5; i++) {
      detector.track("test");
    }

    // Window 2: in cooldown (2→1), fire 10 calls — should update peak to 10
    await Bun.sleep(60);
    for (let i = 0; i < 10; i++) {
      detector.track("test");
    }

    // Window 3: cooldown expires (1→0) — summary emitted with peak from window 2
    await Bun.sleep(60);
    detector.track("test"); // triggers window boundary → summary

    const summary = logs.find((l) => l.msg.includes("Cooldown ended"));
    expect(summary).toBeDefined();
    expect(summary!.ctx.peakCount).toBe(10);
    detector.dispose();
  });

  test("cooldownWindows: 0 disables cooldown", () => {
    const { detector, logs } = setup({ test: { rate: 5, windowMs: 60_000, cooldownWindows: 0 } });
    for (let i = 0; i < 20; i++) {
      detector.track("test");
    }
    // No cooldown — just the normal warn + error
    expect(logs).toHaveLength(2);
    detector.dispose();
  });
});
