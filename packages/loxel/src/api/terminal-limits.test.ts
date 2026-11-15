import { describe, expect, test } from "bun:test";

import {
  clampScrollbackLines,
  clampTerminalSize,
  DEFAULT_SCROLLBACK_LINES,
} from "./terminal-limits";

describe("clampTerminalSize", () => {
  test("floors, clamps and falls back for non-finite values", () => {
    expect(clampTerminalSize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize(120.9, 40.2)).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize(0, 0)).toEqual({ cols: 2, rows: 1 });
    expect(clampTerminalSize(50_000, 50_000)).toEqual({ cols: 1_000, rows: 500 });
    expect(clampTerminalSize(Infinity, NaN)).toEqual({ cols: 80, rows: 24 });
  });
});

describe("clampScrollbackLines", () => {
  test("defaults and clamps", () => {
    expect(clampScrollbackLines(undefined)).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(clampScrollbackLines(10)).toBe(1_000);
    expect(clampScrollbackLines(5_000)).toBe(5_000);
    expect(clampScrollbackLines(10_000_000)).toBe(100_000);
  });
});
