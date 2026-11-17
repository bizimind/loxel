import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { GracePeriods } from "./grace-periods";

describe("GracePeriods", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("ends a key once its period has passed", () => {
    const periods = new GracePeriods<string>(1000);
    const ended: string[] = [];
    periods.start("a", () => ended.push("a"));

    jest.advanceTimersByTime(999);
    expect(ended).toEqual([]);
    expect(periods.has("a")).toBe(true);

    jest.advanceTimersByTime(1);
    expect(ended).toEqual(["a"]);
    expect(periods.has("a")).toBe(false);
  });

  test("a cancelled period never ends", () => {
    const periods = new GracePeriods<string>(1000);
    const ended: string[] = [];
    periods.start("a", () => ended.push("a"));

    expect(periods.cancel("a")).toBe(true);
    expect(periods.cancel("a")).toBe(false);
    jest.advanceTimersByTime(5000);
    expect(ended).toEqual([]);
  });

  test("starting a key again restarts its period with the new end", () => {
    const periods = new GracePeriods<string>(1000);
    const ended: string[] = [];
    periods.start("a", () => ended.push("first"));
    jest.advanceTimersByTime(600);
    periods.start("a", () => ended.push("second"));

    jest.advanceTimersByTime(600);
    expect(ended).toEqual([]);
    jest.advanceTimersByTime(400);
    expect(ended).toEqual(["second"]);
  });

  test("clear stops every period", () => {
    const periods = new GracePeriods<string>(1000);
    const ended: string[] = [];
    periods.start("a", () => ended.push("a"));
    periods.start("b", () => ended.push("b"));

    periods.clear();
    jest.advanceTimersByTime(5000);
    expect(ended).toEqual([]);
    expect(periods.has("a")).toBe(false);
  });
});
