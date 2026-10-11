/**
 * Server-side view of the terminal settings the renderer persists in the `settings` store
 * (zustand persist JSON: `{ state: { terminal: { notificationSequences } }, version }`).
 * Notification sequences are detected on the server, so it has to know which ones are enabled.
 */
import { getStore } from "./store-db";
import type { NotificationSequence } from "./terminal-session";

export type NotificationSequences = Record<NotificationSequence, boolean>;

const ALL_ENABLED: NotificationSequences = { osc9: true, osc777: true, osc99: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the enabled notification sequences from a persisted settings JSON string.
 * Anything missing or malformed defaults to enabled, matching the renderer's defaults.
 */
export function parseNotificationSequences(raw: string | null): NotificationSequences {
  if (!raw) return ALL_ENABLED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ALL_ENABLED;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state) || !isRecord(parsed.state.terminal)) {
    return ALL_ENABLED;
  }
  const sequences = parsed.state.terminal.notificationSequences;
  if (!isRecord(sequences)) return ALL_ENABLED;
  const flag = (key: NotificationSequence): boolean =>
    typeof sequences[key] === "boolean" ? sequences[key] : true;
  return { osc9: flag("osc9"), osc777: flag("osc777"), osc99: flag("osc99") };
}

/** Whether the given notification sequence is enabled in the persisted settings. */
export function isNotificationSequenceEnabled(sequence: NotificationSequence): boolean {
  return parseNotificationSequences(getStore("settings"))[sequence];
}
