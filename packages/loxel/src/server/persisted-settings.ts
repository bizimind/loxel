/**
 * Server-side access to the settings the renderer persists in the `settings` store (zustand
 * persist JSON: `{ state: { ... }, version }`), for the few settings the server reads on its own.
 */
import { isRecord } from "@/lib/is-record";

export const SETTINGS_STORE_KEY = "settings";

/** The `state` object of a persisted settings JSON string; null if missing or malformed. */
export function persistedSettingsState(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
  return parsed.state;
}
