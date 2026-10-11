import { describe, expect, test } from "bun:test";

import { parseNotificationSequences } from "./terminal-settings";

const all = { osc9: true, osc777: true, osc99: true };

describe("parseNotificationSequences", () => {
  test("defaults to all enabled when the store is empty or malformed", () => {
    expect(parseNotificationSequences(null)).toEqual(all);
    expect(parseNotificationSequences("")).toEqual(all);
    expect(parseNotificationSequences("not json")).toEqual(all);
    expect(parseNotificationSequences("[]")).toEqual(all);
    expect(parseNotificationSequences(JSON.stringify({ state: null }))).toEqual(all);
    expect(parseNotificationSequences(JSON.stringify({ state: { terminal: 3 } }))).toEqual(all);
    expect(
      parseNotificationSequences(JSON.stringify({ state: { terminal: { scrollbackLines: 1 } } })),
    ).toEqual(all);
  });

  test("reads persisted flags and treats missing or non-boolean ones as enabled", () => {
    const raw = JSON.stringify({
      state: { terminal: { notificationSequences: { osc9: false, osc777: "no" } } },
      version: 12,
    });
    expect(parseNotificationSequences(raw)).toEqual({ osc9: false, osc777: true, osc99: true });
  });
});
