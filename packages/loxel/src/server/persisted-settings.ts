/**
 * Access to the settings the renderer persists in the `settings` store (zustand persist JSON:
 * `{ state: { ... }, version }`), for the few settings read outside the renderer: by the server,
 * and by Electron main for the automatic update check and the theme windows open in.
 */
// Relative, not `@/`: Electron main's build has no path aliases.
import { isRecord } from "../lib/is-record";
import { parseThemePreference, type ThemePreference } from "../lib/theme-preference";

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
 * Whether the `autoCheckForUpdates` setting allows the automatic update check, given the persisted
 * settings JSON string. On by default, but a row that cannot be parsed might hold the user's
 * opt-out, so it counts as off.
 */
export function isAutoCheckEnabled(raw: string | null): boolean {
  if (raw === null) return true;
  const state = persistedSettingsState(raw);
  return state !== null && state.autoCheckForUpdates !== false;
}

/** The theme setting in the persisted settings JSON string; the default (dark) when unset. */
export function persistedTheme(raw: string | null): ThemePreference {
  return parseThemePreference(persistedSettingsState(raw)?.theme);
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
