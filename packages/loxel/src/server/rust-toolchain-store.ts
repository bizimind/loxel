import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "rust-toolchain:";

/** Store-database key holding the Rust toolchain chosen for a worktree. */
export function rustChoiceStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The toolchain chosen for a worktree, or null when it uses automatic detection. */
export function getRustChoice(wtPath: string): string | null {
  try {
    // Inside the try: a store that cannot be read falls back to automatic detection instead of
    // failing every resolution of the worktree.
    const raw = getStore(rustChoiceStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "toolchain" in parsed) {
      const { toolchain } = parsed;
      return typeof toolchain === "string" && toolchain !== "" ? toolchain : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable Rust toolchain choice", { wtPath, error: err });
  }
  return null;
}

/** Choose the toolchain for a worktree; null returns it to automatic detection. */
export function setRustChoice(wtPath: string, toolchain: string | null): void {
  const key = rustChoiceStoreKey(wtPath);
  if (toolchain === null) deleteStore(key);
  else putStore(key, JSON.stringify({ toolchain }));
}

/** Call `listener` with the worktree path whenever a worktree's choice is set or cleared. */
export function onRustChoiceChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
