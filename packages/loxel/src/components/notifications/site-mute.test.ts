import { describe, expect, test } from "bun:test";

import { isMuteActive } from "@/electron/browser-notification-protocol";

import { SNOOZE_OPTIONS, muteLabel } from "./site-mute";

/** A local date and time, so the checks hold in any time zone. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();
const time = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("snooze options", () => {
  const [oneHour, tomorrow] = SNOOZE_OPTIONS;

  test("one hour ends an hour from now", () => {
    expect(oneHour!.until(at(16, 22, 30))).toBe(at(16, 23, 30));
  });

  test("until tomorrow ends the next morning at 9, late at night too", () => {
    expect(tomorrow!.until(at(16, 10))).toBe(at(17, 9));
    expect(tomorrow!.until(at(16, 23, 59))).toBe(at(17, 9));
  });
});

describe("muteLabel", () => {
  const now = at(16, 10);

  test("a mute without an end reads as muted", () => {
    expect(muteLabel({}, now)).toBe("Muted");
  });

  test("a snooze reads as its end: today's time, tomorrow, or a date", () => {
    expect(muteLabel({ until: at(16, 11) }, now)).toBe(`Snoozed until ${time(at(16, 11))}`);
    expect(muteLabel({ until: at(17, 9) }, now)).toBe(`Snoozed until tomorrow, ${time(at(17, 9))}`);
    expect(muteLabel({ until: at(20, 9) }, now)).toStartWith("Snoozed until ");
    expect(muteLabel({ until: at(20, 9) }, now)).not.toContain("tomorrow");
  });
});

describe("isMuteActive", () => {
  test("a mute lasts until removed, a snooze until its end", () => {
    expect(isMuteActive(undefined, 0)).toBe(false);
    expect(isMuteActive({}, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isMuteActive({ until: 10 }, 9)).toBe(true);
    expect(isMuteActive({ until: 10 }, 10)).toBe(false);
  });
});
