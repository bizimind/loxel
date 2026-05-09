import { describe, test, expect } from "bun:test";

import { findNextAvailableIndex } from "./state.ts";

describe("findNextAvailableIndex", () => {
  test("empty array returns 0", () => {
    expect(findNextAvailableIndex([])).toBe(0);
  });

  test("[0] returns 1", () => {
    expect(findNextAvailableIndex([0])).toBe(1);
  });

  test("[0, 1] returns 2", () => {
    expect(findNextAvailableIndex([0, 1])).toBe(2);
  });

  test("[0, 2] returns 1 (gap reuse)", () => {
    expect(findNextAvailableIndex([0, 2])).toBe(1);
  });

  test("[1, 2] returns 0 (lowest available)", () => {
    expect(findNextAvailableIndex([1, 2])).toBe(0);
  });

  test("[0, 1, 2, 4, 5] returns 3 (gap reuse)", () => {
    expect(findNextAvailableIndex([0, 1, 2, 4, 5])).toBe(3);
  });

  test("[5, 3, 1] returns 0 (unordered input)", () => {
    expect(findNextAvailableIndex([5, 3, 1])).toBe(0);
  });

  test("[0, 0, 0] with duplicates returns 1", () => {
    expect(findNextAvailableIndex([0, 0, 0])).toBe(1);
  });

  test("large indices work", () => {
    expect(findNextAvailableIndex([100, 200, 300])).toBe(0);
  });

  test("consecutive starting from 0 returns next", () => {
    expect(findNextAvailableIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(10);
  });
});
