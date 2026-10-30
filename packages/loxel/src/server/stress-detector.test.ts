import { describe, expect, test } from "bun:test";

import type { LogFn, StressCheckpointConfig } from "./stress-detector";
import { createStressDetector } from "./stress-detector";

interface LogCall {
  level: "warn" | "error";
  msg: string;
  ctx: Record<string, unknown>;
}

function setup(checkpoints: Record<string, StressCheckpointConfig>) {
  const logs: LogCall[] = [];
  const logFn: LogFn = (level, msg, ctx) => logs.push({ level, msg, ctx });
  let time = 1_000_000;
  const detector = createStressDetector(checkpoints, { logFn, now: () => time });
  return {
    detector,
    logs,
    advance: (ms: number) => {
      time += ms;
    },
    fire: (name: string, times: number, key?: string) => {
      for (let i = 0; i < times; i++) detector.track(name, key);
    },
  };
}

const summaries = (logs: LogCall[]) => logs.filter((l) => l.msg.includes("back to normal"));

describe("stress-detector", () => {
  test("track on unknown checkpoint is a no-op", () => {
    const { detector, logs } = setup({ known: { rate: 5 } });
    detector.track("unknown");
    detector.track("unknown", "foo");
    expect(logs).toHaveLength(0);
    detector.dispose();
  });

  test("no logs at or below the warn threshold", () => {
    const { detector, logs, fire } = setup({ test: { rate: 10 } });
    fire("test", 5); // warnThreshold = floor(10 * 0.5) = 5
    expect(logs).toHaveLength(0);
    detector.dispose();
  });

  test("warns entering an elevated rate and errors escalating to a high one", () => {
    const { detector, logs, fire } = setup({ test: { rate: 10 } });
    fire("test", 11);
    expect(logs).toHaveLength(2);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.msg).toContain("[stress]");
    expect(logs[0]!.ctx.count).toBe(6);
    expect(logs[0]!.ctx.warnThreshold).toBe(5);
    expect(logs[1]!.level).toBe("error");
    expect(logs[1]!.ctx.count).toBe(11);
    expect(logs[1]!.ctx.threshold).toBe(10);
    detector.dispose();
  });

  test("a sustained high rate logs its entry once, not once per window", () => {
    const { detector, logs, fire, advance } = setup({ test: { rate: 5, windowMs: 1000 } });
    for (let window = 0; window < 60; window++) {
      fire("test", 20);
      advance(1000);
    }
    expect(logs.map((l) => l.level)).toEqual(["warn", "error"]);
    detector.dispose();
  });

  test("a sustained elevated rate escalates when it later goes high", () => {
    const { detector, logs, fire, advance } = setup({ test: { rate: 10, windowMs: 1000 } });
    fire("test", 6);
    advance(1000);
    fire("test", 6);
    expect(logs.map((l) => l.level)).toEqual(["warn"]);
    advance(1000);
    fire("test", 11);
    expect(logs.map((l) => l.level)).toEqual(["warn", "error"]);
    detector.dispose();
  });

  test("summarises once when the rate has stayed low for calmWindows", () => {
    const { detector, logs, fire, advance } = setup({
      test: { rate: 10, windowMs: 1000, calmWindows: 3 },
    });
    fire("test", 30);
    advance(1000);
    fire("test", 8); // still above the warn threshold: last hot moment
    advance(1000);
    expect(logs).toHaveLength(2);

    for (let window = 0; window < 3; window++) {
      fire("test", 1);
      advance(1000);
    }
    fire("test", 1); // closes the third calm window
    const summary = summaries(logs);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.level).toBe("warn");
    expect(summary[0]!.ctx).toMatchObject({ level: "high", peakCount: 30, durationMs: 1000 });
    detector.dispose();
  });

  test("a brief dip does not end the episode", () => {
    const { detector, logs, fire, advance } = setup({
      test: { rate: 10, windowMs: 1000, calmWindows: 3 },
    });
    for (let burst = 0; burst < 10; burst++) {
      fire("test", 11);
      advance(1000);
      fire("test", 1);
      advance(1000);
    }
    expect(logs.map((l) => l.level)).toEqual(["warn", "error"]);
    detector.dispose();
  });

  test("a new episode logs again after the previous one ended", () => {
    const { detector, logs, fire, advance } = setup({
      test: { rate: 5, windowMs: 1000, calmWindows: 1 },
    });
    fire("test", 6);
    advance(2000);
    detector.sweep();
    expect(summaries(logs)).toHaveLength(1);
    fire("test", 6);
    expect(logs.map((l) => l.level)).toEqual(["warn", "error", "warn", "warn", "error"]);
    detector.dispose();
  });

  test("sweep ends the episode of a rate that stopped entirely", () => {
    const { detector, logs, fire, advance } = setup({
      test: { rate: 5, windowMs: 1000, calmWindows: 5 },
    });
    fire("test", 6);
    advance(4000);
    detector.sweep();
    expect(summaries(logs)).toHaveLength(0);
    advance(2000);
    detector.sweep();
    expect(summaries(logs)).toHaveLength(1);
    detector.dispose();
  });

  test("rate+key: different keys are independent", () => {
    const { detector, logs, fire } = setup({ test: { rate: 10 } });
    fire("test", 4, "a");
    fire("test", 4, "b");
    // Global: 8 calls > warn(5), no error(10). Per key: 4 each < warn(5).
    expect(logs.map((l) => l.level)).toEqual(["warn"]);
    expect(logs[0]!.ctx.key).toBeUndefined();
    detector.dispose();
  });

  test("rate+key: an identical key triggers its own alert", () => {
    const { detector, logs, fire } = setup({ test: { rate: 5 } });
    fire("test", 8, "loop");
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(2);
    const keyed = logs.filter((l) => l.ctx.key !== undefined);
    expect(keyed).toHaveLength(2);
    expect(keyed[0]!.ctx.key).toBe("loop");
    detector.dispose();
  });

  test("rate+key: a key's episode survives window rollover and is summarised once", () => {
    const { detector, logs, fire, advance } = setup({
      test: { rate: 5, windowMs: 1000, calmWindows: 2 },
    });
    for (let window = 0; window < 5; window++) {
      fire("test", 8, "loop");
      advance(1000);
    }
    expect(logs.filter((l) => l.ctx.key === "loop")).toHaveLength(2);
    advance(2000);
    detector.sweep();
    const keyed = summaries(logs).filter((l) => l.ctx.key === "loop");
    expect(keyed).toHaveLength(1);
    expect(keyed[0]!.ctx.peakCount).toBe(8);
    detector.dispose();
  });

  test("custom warnRatio", () => {
    const { detector, logs, fire } = setup({ test: { rate: 10, warnRatio: 0.3 } });
    fire("test", 4);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.ctx.warnThreshold).toBe(3);
    detector.dispose();
  });

  test("key cap prevents unbounded growth", () => {
    const { detector, logs } = setup({ test: { rate: 1000 } });
    for (let i = 0; i < 600; i++) detector.track("test", String(i));
    // Should not OOM or throw. Global still tracks all 600 calls (warn at 501).
    const globalWarn = logs.find((l) => l.level === "warn" && l.ctx.key === undefined);
    expect(globalWarn).toBeDefined();
    detector.dispose();
  });

  test("dispose makes subsequent tracks no-ops", () => {
    const { detector, logs, fire } = setup({ test: { rate: 5 } });
    detector.dispose();
    fire("test", 20);
    expect(logs).toHaveLength(0);
  });

  test("multiple checkpoints are independent", () => {
    const { detector, logs, fire } = setup({ a: { rate: 3 }, b: { rate: 100 } });
    fire("a", 5);
    fire("b", 5);
    expect(logs.filter((l) => l.ctx.checkpoint === "a")).toHaveLength(2);
    expect(logs.filter((l) => l.ctx.checkpoint === "b")).toHaveLength(0);
    detector.dispose();
  });
});
