import { describe, test, expect } from "bun:test";

import { ExponentialBackoff } from "../src/backoff.ts";

describe("ExponentialBackoff", () => {
  test("returns increasing delays", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 100, maxDelay: 10000, maxAttempts: 10 });

    const delay1 = backoff.nextDelay()!;
    const delay2 = backoff.nextDelay()!;
    const delay3 = backoff.nextDelay()!;

    // Delays should generally increase (accounting for jitter)
    // First delay is ~100ms (100-125), second is ~200ms (200-250), etc.
    expect(delay1).toBeGreaterThanOrEqual(100);
    expect(delay1).toBeLessThanOrEqual(125);

    expect(delay2).toBeGreaterThanOrEqual(200);
    expect(delay2).toBeLessThanOrEqual(250);

    expect(delay3).toBeGreaterThanOrEqual(400);
    expect(delay3).toBeLessThanOrEqual(500);
  });

  test("respects maxDelay", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 1000, maxDelay: 2000, maxAttempts: 10 });

    // After a few attempts, delay should cap at maxDelay
    for (let i = 0; i < 5; i++) {
      backoff.nextDelay();
    }

    const delay = backoff.nextDelay()!;
    // Even with jitter, should not exceed maxDelay * 1.25
    expect(delay).toBeLessThanOrEqual(2500);
  });

  test("returns null after max attempts", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 100, maxDelay: 10000, maxAttempts: 3 });

    expect(backoff.nextDelay()).not.toBeNull();
    expect(backoff.nextDelay()).not.toBeNull();
    expect(backoff.nextDelay()).not.toBeNull();
    expect(backoff.nextDelay()).toBeNull();
    expect(backoff.nextDelay()).toBeNull(); // Still null
  });

  test("reset restores initial state", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 100, maxDelay: 10000, maxAttempts: 3 });

    backoff.nextDelay();
    backoff.nextDelay();
    expect(backoff.currentAttempt).toBe(2);

    backoff.reset();
    expect(backoff.currentAttempt).toBe(0);

    const delay = backoff.nextDelay()!;
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThanOrEqual(125);
  });

  test("tracks current attempt", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 100, maxDelay: 10000, maxAttempts: 5 });

    expect(backoff.currentAttempt).toBe(0);
    backoff.nextDelay();
    expect(backoff.currentAttempt).toBe(1);
    backoff.nextDelay();
    expect(backoff.currentAttempt).toBe(2);
  });

  test("handles zero maxAttempts", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 100, maxDelay: 10000, maxAttempts: 0 });

    expect(backoff.nextDelay()).toBeNull();
  });

  test("handles single attempt", () => {
    const backoff = new ExponentialBackoff({ baseDelay: 100, maxDelay: 10000, maxAttempts: 1 });

    const delay = backoff.nextDelay();
    expect(delay).not.toBeNull();
    expect(backoff.nextDelay()).toBeNull();
  });
});
