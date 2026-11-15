import { afterEach, describe, expect, jest, test } from "bun:test";

import { awakeTimeout } from "./awake-timer";

afterEach(() => {
  jest.useRealTimers();
});

/** Let what the timers set off run, I/O and immediates included. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("awakeTimeout", () => {
  test("expires once its time has passed awake, after the I/O already pending", async () => {
    jest.useFakeTimers();
    let expired = false;
    awakeTimeout(1000, () => {
      expired = true;
    });
    jest.advanceTimersByTime(999);
    await settle();
    expect(expired).toBe(false);
    jest.advanceTimersByTime(1);
    // Not in the timer's own turn: an answer read on the same wake comes first.
    expect(expired).toBe(false);
    await settle();
    expect(expired).toBe(true);
  });

  test("a window the machine slept in starts over", async () => {
    jest.useFakeTimers();
    let expired = false;
    awakeTimeout(1000, () => {
      expired = true;
    });
    // The wall clock jumps an hour while the monotonic clock stands still, as across a sleep.
    jest.setSystemTime(Date.now() + 3_600_000);
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(false);
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(true);
  });

  test("a window whose timer fired long after it was due starts over", async () => {
    jest.useFakeTimers();
    const clocks = { wall: () => awake, awake: () => awake };
    let awake = 0;
    let expired = false;
    awakeTimeout(
      1000,
      () => {
        expired = true;
      },
      clocks,
    );
    // The process did not run for a minute: its timer fires late, on both clocks.
    awake = 61_000;
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(false);
    awake += 1000;
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(true);
  });

  test("a timer late again and again with no sleep expires after one fresh window", async () => {
    jest.useFakeTimers();
    let awake = 0;
    const clocks = { wall: () => awake, awake: () => awake };
    let expired = false;
    awakeTimeout(
      1000,
      () => {
        expired = true;
      },
      clocks,
    );
    // An event loop blocked for ten seconds at a time, every time: late on both clocks, no sleep.
    awake += 11_000;
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(false);
    awake += 11_000;
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(true);
  });

  test("sleeps re-arm it however often", async () => {
    jest.useFakeTimers();
    let expired = false;
    awakeTimeout(1000, () => {
      expired = true;
    });
    for (let night = 0; night < 3; night++) {
      jest.setSystemTime(Date.now() + 3_600_000);
      jest.advanceTimersByTime(1000);
      await settle();
      expect(expired).toBe(false);
    }
    jest.advanceTimersByTime(1000);
    await settle();
    expect(expired).toBe(true);
  });

  test("cancelled, it never expires", async () => {
    jest.useFakeTimers();
    let expired = false;
    const cancel = awakeTimeout(1000, () => {
      expired = true;
    });
    jest.advanceTimersByTime(1000);
    cancel();
    await settle();
    expect(expired).toBe(false);
  });
});
