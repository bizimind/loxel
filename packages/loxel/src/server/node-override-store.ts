import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "node-version:";

/** Store-database key holding the Node chosen for a worktree. */
export function nodeOverrideStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The `node` chosen for a worktree, or null when it uses automatic detection. */
export function getNodeOverride(wtPath: string): string | null {
  try {
    const raw = getStore(nodeOverrideStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "nodePath" in parsed) {
      const { nodePath } = parsed;
      return typeof nodePath === "string" && path.isAbsolute(nodePath) ? nodePath : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable Node version override", { wtPath, error: err });
  }
  return null;
}

/** Choose the `node` for a worktree; null returns it to automatic detection. */
export function setNodeOverride(wtPath: string, nodePath: string | null): void {
  const key = nodeOverrideStoreKey(wtPath);
  if (nodePath === null) deleteStore(key);
  else putStore(key, JSON.stringify({ nodePath }));
}

/** Call `listener` with the worktree path whenever a worktree's override is set or cleared. */
export function onNodeOverrideChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
