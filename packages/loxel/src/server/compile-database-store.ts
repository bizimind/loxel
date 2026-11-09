import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "compile-database:";

/** Store-database key holding the compile database folder chosen for a worktree. */
export function compileDatabaseStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The folder chosen for a worktree, or null when it uses automatic detection. */
export function getCompileDatabaseChoice(wtPath: string): string | null {
  try {
    // Inside the try: a store that cannot be read falls back to automatic detection instead of
    // failing every start of the worktree's clangd.
    const raw = getStore(compileDatabaseStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "dir" in parsed) {
      const { dir } = parsed;
      // Written only by the choice route, which stores absolute paths.
      return typeof dir === "string" && path.isAbsolute(dir) ? dir : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable compile database choice", { wtPath, error: err });
  }
  return null;
}

/** Choose the folder for a worktree; null returns it to automatic detection. */
export function setCompileDatabaseChoice(wtPath: string, dir: string | null): void {
  const key = compileDatabaseStoreKey(wtPath);
  if (dir === null) deleteStore(key);
  else putStore(key, JSON.stringify({ dir }));
}

/** Call `listener` with the worktree path whenever a worktree's choice is set or cleared. */
export function onCompileDatabaseChoiceChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
