import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "python-interpreter:";

/** Store-database key holding the Python interpreter chosen for a worktree. */
export function pythonOverrideStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The interpreter chosen for a worktree, or null when it uses automatic detection. */
export function getPythonOverride(wtPath: string): string | null {
  try {
    // Inside the try: a store that cannot be read falls back to automatic detection instead of
    // failing every resolution of the worktree.
    const raw = getStore(pythonOverrideStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "pythonPath" in parsed) {
      const { pythonPath } = parsed;
      // Written only by the override route, which stores absolute paths.
      return typeof pythonPath === "string" && path.isAbsolute(pythonPath) ? pythonPath : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable Python interpreter override", { wtPath, error: err });
  }
  return null;
}

/** Choose the interpreter for a worktree; null returns it to automatic detection. */
export function setPythonOverride(wtPath: string, pythonPath: string | null): void {
  const key = pythonOverrideStoreKey(wtPath);
  if (pythonPath === null) deleteStore(key);
  else putStore(key, JSON.stringify({ pythonPath }));
}

/** Call `listener` with the worktree path whenever a worktree's override is set or cleared. */
export function onPythonOverrideChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
