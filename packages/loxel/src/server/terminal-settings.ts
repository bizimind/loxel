/**
 * Server-side view of the terminal settings the renderer persists in the `settings` store
 * (zustand persist JSON: `{ state: { terminal: { notificationSequences } }, version }`).
 * Notification sequences are detected on the server, so it has to know which ones are enabled.
 */
import type { NotificationSequence, NotificationSequences } from "@/api/ws-protocol";
import { DEFAULT_NOTIFICATION_SEQUENCES, NOTIFICATION_SEQUENCES } from "@/api/ws-protocol";

import { getStore } from "./store-db";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the enabled notification sequences from a persisted settings JSON string.
 * Anything missing or malformed falls back to `DEFAULT_NOTIFICATION_SEQUENCES`.
 */
export function parseNotificationSequences(raw: string | null): NotificationSequences {
  if (!raw) return DEFAULT_NOTIFICATION_SEQUENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_NOTIFICATION_SEQUENCES;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state) || !isRecord(parsed.state.terminal)) {
    return DEFAULT_NOTIFICATION_SEQUENCES;
  }
  const sequences = parsed.state.terminal.notificationSequences;
  if (!isRecord(sequences)) return DEFAULT_NOTIFICATION_SEQUENCES;
  const result = { ...DEFAULT_NOTIFICATION_SEQUENCES };
  for (const key of NOTIFICATION_SEQUENCES) {
    const flag = sequences[key];
    if (typeof flag === "boolean") result[key] = flag;
  }
  return result;
}

/** Whether the given notification sequence is enabled in the persisted settings. */
export function isNotificationSequenceEnabled(sequence: NotificationSequence): boolean {
  return parseNotificationSequences(getStore("settings"))[sequence];
}
