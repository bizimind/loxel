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

/**
 * Removes what the built-in coding agent kept in persisted settings, API keys included, from a row
 * of the settings store: old rows on read, and writes from windows still running an older renderer,
 * which would otherwise put keys back. Returns `raw` itself when there is nothing to remove.
 */
export function stripLegacyAgentSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return raw;
  if (!("models" in parsed.state) && !("codingAgent" in parsed.state)) return raw;
  const { models: _models, codingAgent: _codingAgent, ...state } = parsed.state;
  return JSON.stringify({ ...parsed, state });
}
