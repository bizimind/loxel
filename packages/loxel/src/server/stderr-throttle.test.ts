import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";

import { createStderrThrottle } from "./stderr-throttle";

// Fixed baseline so Date.now() arithmetic is deterministic across runs.
const BASELINE = new Date("2026-01-01T00:00:00Z");

beforeEach(() => {
  setSystemTime(BASELINE);
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

/**
 * Advance both the fake interval queue and `Date.now()` in lockstep.
 * Bun's `jest.advanceTimersByTime` moves the system clock on some platforms
 * but not others, so restore the explicitly calculated target afterward.
 */
function advance(ms: number): void {
  const target = new Date(Date.now() + ms);
  jest.advanceTimersByTime(ms);
  setSystemTime(target);
}

describe("stderr-throttle", () => {
  test("allows up to capacity instantly as a burst", () => {
    const throttle = createStderrThrottle({
      capacity: 5,
      refillPerSec: 1,
      flushIntervalMs: 1000,
      onSummary: () => {},
    });
    let emitted = 0;
    for (let i = 0; i < 5; i++) {
      if (throttle.tryConsume()) emitted++;
    }
    expect(emitted).toBe(5);
    throttle.dispose();
  });

  test("drops once bucket is exhausted and no time has passed", () => {
    const summaries: number[] = [];
    const throttle = createStderrThrottle({
      capacity: 3,
      refillPerSec: 10,
      flushIntervalMs: 5000,
      onSummary: (n) => summaries.push(n),
    });
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(throttle.tryConsume());
    expect(results).toEqual([true, true, true, false, false]);
    expect(summaries).toEqual([]);
    throttle.dispose();
    // dispose flushes the pending summary.
    expect(summaries).toEqual([2]);
  });

  test("refills at the configured rate over time", () => {
    const throttle = createStderrThrottle({
      capacity: 2,
      refillPerSec: 10, // 1 token / 100 ms
      flushIntervalMs: 5000,
      onSummary: () => {},
    });
    expect(throttle.tryConsume()).toBe(true);
    expect(throttle.tryConsume()).toBe(true);
    expect(throttle.tryConsume()).toBe(false);

    // After 50ms we've accumulated 0.5 tokens — still not enough.
    advance(50);
    expect(throttle.tryConsume()).toBe(false);

    // Another 50ms (100ms total) — now 1 token has been restored.
    advance(50);
    expect(throttle.tryConsume()).toBe(true);
    expect(throttle.tryConsume()).toBe(false);
    throttle.dispose();
  });

  test("refill is capped at capacity — no save-up forever", () => {
    const throttle = createStderrThrottle({
      capacity: 3,
      refillPerSec: 10,
      flushIntervalMs: 5000,
      onSummary: () => {},
    });
    advance(60_000); // would refill 600 tokens if uncapped
    expect(throttle.tryConsume()).toBe(true);
    expect(throttle.tryConsume()).toBe(true);
    expect(throttle.tryConsume()).toBe(true);
    expect(throttle.tryConsume()).toBe(false);
    throttle.dispose();
  });

  test("tick emits a summary when lines were dropped, then resets the counter", () => {
    const summaries: number[] = [];
    const throttle = createStderrThrottle({
      capacity: 1,
      refillPerSec: 0.0001,
      flushIntervalMs: 5000,
      onSummary: (n) => summaries.push(n),
    });
    throttle.tryConsume();
    for (let i = 0; i < 7; i++) throttle.tryConsume();
    advance(5000); // fire the summary interval
    expect(summaries).toEqual([7]);

    for (let i = 0; i < 3; i++) throttle.tryConsume();
    advance(5000);
    expect(summaries).toEqual([7, 3]);
    throttle.dispose();
  });

  test("tick with no drops is a no-op (no noisy zero summaries)", () => {
    const summaries: number[] = [];
    const throttle = createStderrThrottle({
      capacity: 5,
      refillPerSec: 1,
      flushIntervalMs: 5000,
      onSummary: (n) => summaries.push(n),
    });
    throttle.tryConsume();
    throttle.tryConsume();
    advance(5000);
    expect(summaries).toEqual([]);
    throttle.dispose();
    expect(summaries).toEqual([]);
  });

  test("dispose clears the timer and emits a final pending summary", () => {
    const summaries: number[] = [];
    const throttle = createStderrThrottle({
      capacity: 1,
      refillPerSec: 0.0001,
      flushIntervalMs: 5000,
      onSummary: (n) => summaries.push(n),
    });
    throttle.tryConsume();
    for (let i = 0; i < 4; i++) throttle.tryConsume();
    throttle.dispose();
    expect(summaries).toEqual([4]);

    // Post-dispose: all consumes are silently dropped without counting.
    expect(throttle.tryConsume()).toBe(false);
    // Idempotent dispose.
    throttle.dispose();
    expect(summaries).toEqual([4]);

    // Summary timer no longer fires (advancing past the flush interval is a
    // no-op because dispose cleared it).
    advance(10_000);
    expect(summaries).toEqual([4]);
  });

  test("multi-line chunks consume one token per non-empty line (not per chunk)", () => {
    // Regression: a previous version called tryConsume() once per stdout read,
    // so a 1000-line chunk only consumed one token. Simulate the fixed
    // readStderr loop: split on \n and consume per non-empty line.
    const summaries: number[] = [];
    const throttle = createStderrThrottle({
      capacity: 3,
      refillPerSec: 0.0001,
      flushIntervalMs: 5000,
      onSummary: (n) => summaries.push(n),
    });
    const chunk = "line1\nline2\n\nline3\nline4\nline5\n"; // 5 non-empty lines
    let emitted = 0;
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (throttle.tryConsume()) emitted++;
    }
    expect(emitted).toBe(3);
    throttle.dispose();
    expect(summaries).toEqual([2]);
  });

  test("burst followed by sustained rate matches the refill rate", () => {
    // capacity=200, refill=50/s (the production defaults). After the initial
    // burst is drained we should be allowed ~50 lines/sec steady-state.
    const throttle = createStderrThrottle({
      capacity: 200,
      refillPerSec: 50,
      flushIntervalMs: 5000,
      onSummary: () => {},
    });
    let emitted = 0;
    for (let i = 0; i < 200; i++) {
      if (throttle.tryConsume()) emitted++;
    }
    expect(emitted).toBe(200);

    // Over the next second, try 1000 lines at roughly uniform cadence. Only
    // ~50 should get through.
    emitted = 0;
    for (let i = 0; i < 1000; i++) {
      advance(1); // 1ms between attempts → 1s total
      if (throttle.tryConsume()) emitted++;
    }
    // Allow one token of slack for rounding at the boundary.
    expect(emitted).toBeGreaterThanOrEqual(49);
    expect(emitted).toBeLessThanOrEqual(51);
    throttle.dispose();
  });
});
