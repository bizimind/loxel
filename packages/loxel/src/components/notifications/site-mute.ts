/**
 * Muting and snoozing a site's browser notifications: the snooze lengths offered, how a mute reads,
 * and the mutes still in effect. Main drops a muted site's notifications (see
 * `browser-notifications.ts`); the mutes themselves live in settings (`browser.notificationMutes`).
 */
import { useEffect, useMemo, useState } from "react";

import {
  type NotificationMute,
  type NotificationMutes,
  isMuteActive,
} from "@/electron/browser-notification-protocol";
import { dayjs } from "@/lib/dayjs";
import { useSettingsStore } from "@/store/settings-store";

/** When "Until tomorrow" ends: the next morning, not midnight, so a late evening stays quiet. */
const TOMORROW_HOUR = 9;
/** setTimeout's longest delay; a later snooze end is checked again after it. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface SnoozeOption {
  label: string;
  until: (now: number) => number;
}

export const SNOOZE_OPTIONS: SnoozeOption[] = [
  { label: "Snooze for 1 hour", until: (now) => dayjs(now).add(1, "hour").valueOf() },
  {
    label: "Snooze until tomorrow",
    until: (now) => dayjs(now).add(1, "day").startOf("day").hour(TOMORROW_HOUR).valueOf(),
  },
];

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Muted", or when the snooze ends: "Snoozed until 3:45 PM", "… until tomorrow, 9:00 AM". */
export function muteLabel(mute: NotificationMute, now: number): string {
  if (mute.until === undefined) return "Muted";
  const end = dayjs(mute.until);
  if (end.isSame(now, "day")) return `Snoozed until ${formatTime(mute.until)}`;
  if (end.isSame(dayjs(now).add(1, "day"), "day")) {
    return `Snoozed until tomorrow, ${formatTime(mute.until)}`;
  }
  return `Snoozed until ${end.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

/** The mutes in effect now, by origin; re-renders when a snooze ends. */
export function useActiveNotificationMutes(): NotificationMutes {
  const mutes = useSettingsStore((s) => s.browser.notificationMutes);
  const [now, setNow] = useState(Date.now);

  const active = useMemo(
    () => Object.fromEntries(Object.entries(mutes).filter(([, m]) => isMuteActive(m, now))),
    [mutes, now],
  );

  useEffect(() => {
    const ends = Object.values(active).flatMap((m) => (m.until === undefined ? [] : [m.until]));
    if (ends.length === 0) return;
    const delay = Math.min(Math.max(0, Math.min(...ends) - Date.now()), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [active]);

  return active;
}
