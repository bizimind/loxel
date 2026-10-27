/**
 * Server-side view of the terminal settings the renderer persists in the `settings` store
 * (zustand persist JSON: `{ state: { terminal: { ... } }, version }`). Notification sequences are
 * detected on the server, so it has to know which ones are enabled, and a shell the server starts
 * with no panel attached (`loxel terminal`) needs the settings a panel would send.
 */
import type { NotificationSequence, NotificationSequences } from "@/api/ws-protocol";
import { DEFAULT_NOTIFICATION_SEQUENCES, NOTIFICATION_SEQUENCES } from "@/api/ws-protocol";

import { getStore, onStoreChange } from "./store-db";
import type { TerminalSpawnOptions } from "./terminal-manager";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The `terminal` section of a persisted settings JSON string; null if missing or malformed. */
function terminalSection(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state) || !isRecord(parsed.state.terminal)) return null;
  return parsed.state.terminal;
}

/**
 * Extract the enabled notification sequences from a persisted settings JSON string.
 * Anything missing or malformed falls back to `DEFAULT_NOTIFICATION_SEQUENCES`.
 */
export function parseNotificationSequences(raw: string | null): NotificationSequences {
  const sequences = terminalSection(raw)?.notificationSequences;
  if (!isRecord(sequences)) return DEFAULT_NOTIFICATION_SEQUENCES;
  const result = { ...DEFAULT_NOTIFICATION_SEQUENCES };
  for (const key of NOTIFICATION_SEQUENCES) {
    const flag = sequences[key];
    if (typeof flag === "boolean") result[key] = flag;
  }
  return result;
}

/** Settings a panel sends when its attach spawns the shell; absent ones take the spawn defaults. */
export type TerminalSpawnSettings = Pick<
  TerminalSpawnOptions,
  "scrollbackLines" | "activatePythonEnv"
>;

/** Extract the {@link TerminalSpawnSettings} from a persisted settings JSON string. */
export function parseTerminalSpawnSettings(raw: string | null): TerminalSpawnSettings {
  const { scrollbackLines, activatePythonEnv } = terminalSection(raw) ?? {};
  return {
    ...(typeof scrollbackLines === "number" ? { scrollbackLines } : {}),
    ...(typeof activatePythonEnv === "boolean" ? { activatePythonEnv } : {}),
  };
}

/**
 * Caches the parsed sequences until `invalidate()` is called. Sequences arrive at a rate the
 * terminal program controls, so each one must not cost a database read and a JSON parse.
 */
export function createNotificationSequencesCache(read: () => string | null): {
  isEnabled: (sequence: NotificationSequence) => boolean;
  invalidate: () => void;
} {
  let cached: NotificationSequences | null = null;
  return {
    isEnabled: (sequence) => {
      cached ??= parseNotificationSequences(read());
      return cached[sequence];
    },
    invalidate: () => {
      cached = null;
    },
  };
}

const SETTINGS_STORE_KEY = "settings";
const cache = createNotificationSequencesCache(() => getStore(SETTINGS_STORE_KEY));
onStoreChange((key) => {
  if (key === SETTINGS_STORE_KEY) cache.invalidate();
});

/** Whether the given notification sequence is enabled in the persisted settings. */
export function isNotificationSequenceEnabled(sequence: NotificationSequence): boolean {
  return cache.isEnabled(sequence);
}

/** The terminal settings for a shell the server starts itself; read on each call. */
export function terminalSpawnSettings(): TerminalSpawnSettings {
  return parseTerminalSpawnSettings(getStore(SETTINGS_STORE_KEY));
}
