import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "go-toolchain:";

/** Store-database key holding the Go chosen for a worktree. */
export function goChoiceStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The `go` binary chosen for a worktree, or null when it uses automatic detection. */
export function getGoChoice(wtPath: string): string | null {
  try {
    // Inside the try: a store that cannot be read falls back to automatic detection instead of
    // failing every resolution of the worktree.
    const raw = getStore(goChoiceStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "goPath" in parsed) {
      const { goPath } = parsed;
      // Written only by the choice route, which stores absolute paths.
      return typeof goPath === "string" && path.isAbsolute(goPath) ? goPath : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable Go toolchain choice", { wtPath, error: err });
  }
  return null;
}

/** Choose the `go` binary for a worktree; null returns it to automatic detection. */
export function setGoChoice(wtPath: string, goPath: string | null): void {
  const key = goChoiceStoreKey(wtPath);
  if (goPath === null) deleteStore(key);
  else putStore(key, JSON.stringify({ goPath }));
}

/** Call `listener` with the worktree path whenever a worktree's choice is set or cleared. */
export function onGoChoiceChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
