import { describe, expect, test } from "bun:test";

import { reconnectDelay } from "./ws-reconnect";

describe("reconnectDelay", () => {
  test("doubles from 250 ms, jittered over the upper half of each step", () => {
    expect([0, 1, 2].map((attempt) => reconnectDelay(attempt, () => 0))).toEqual([125, 250, 500]);
    expect([0, 1, 2].map((attempt) => reconnectDelay(attempt, () => 1))).toEqual([250, 500, 1000]);
  });

  test("stops growing at 10 s", () => {
    expect(reconnectDelay(30, () => 1)).toBe(10_000);
    expect(reconnectDelay(30, () => 0)).toBe(5000);
  });
});
