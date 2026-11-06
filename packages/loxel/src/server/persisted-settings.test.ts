import { describe, expect, test } from "bun:test";

import { isAutoCheckEnabled } from "./persisted-settings";

const persisted = (state: Record<string, unknown>) => JSON.stringify({ state, version: 12 });

describe("isAutoCheckEnabled", () => {
  test("is on when there are no settings yet or they predate the setting", () => {
    expect(isAutoCheckEnabled(null)).toBe(true);
    expect(isAutoCheckEnabled(persisted({ terminal: {} }))).toBe(true);
  });

  test("follows the persisted flag", () => {
    expect(isAutoCheckEnabled(persisted({ autoCheckForUpdates: true }))).toBe(true);
    expect(isAutoCheckEnabled(persisted({ autoCheckForUpdates: false }))).toBe(false);
  });

  test("is off when the row cannot be parsed, since it may hold an opt-out", () => {
    expect(isAutoCheckEnabled("not json")).toBe(false);
    expect(isAutoCheckEnabled("[]")).toBe(false);
    expect(isAutoCheckEnabled(JSON.stringify({ state: null }))).toBe(false);
  });
});
