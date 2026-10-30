import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "java-home:";

/** Store-database key holding the JDK chosen for a worktree. */
export function javaOverrideStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The JDK home chosen for a worktree, or null when it uses automatic detection. */
export function getJavaOverride(wtPath: string): string | null {
  try {
    // Inside the try: a store that cannot be read falls back to automatic detection instead of
    // failing every resolution of the worktree.
    const raw = getStore(javaOverrideStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "javaHome" in parsed) {
      const { javaHome } = parsed;
      // Written only by the override route, which stores absolute paths.
      return typeof javaHome === "string" && path.isAbsolute(javaHome) ? javaHome : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable JDK override", { wtPath, error: err });
  }
  return null;
}

/** Choose the JDK for a worktree; null returns it to automatic detection. */
export function setJavaOverride(wtPath: string, javaHome: string | null): void {
  const key = javaOverrideStoreKey(wtPath);
  if (javaHome === null) deleteStore(key);
  else putStore(key, JSON.stringify({ javaHome }));
}

/** Call `listener` with the worktree path whenever a worktree's override is set or cleared. */
export function onJavaOverrideChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
