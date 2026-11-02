import path from "node:path";

import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "csharp-solution:";

/** Store-database key holding the solution chosen for a worktree. */
export function csharpSolutionStoreKey(wtPath: string): string {
  return `${KEY_PREFIX}${path.resolve(wtPath)}`;
}

/** The solution chosen for a worktree, or null when it uses automatic detection. */
export function getCSharpSolution(wtPath: string): string | null {
  try {
    // Inside the try: a store that cannot be read falls back to automatic detection.
    const raw = getStore(csharpSolutionStoreKey(wtPath));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "solutionPath" in parsed) {
      const { solutionPath } = parsed;
      // Written only by the route, which stores absolute paths.
      return typeof solutionPath === "string" && path.isAbsolute(solutionPath)
        ? solutionPath
        : null;
    }
  } catch (err) {
    log.warn("Ignoring an unreadable C# solution choice", { wtPath, error: err });
  }
  return null;
}

/** Choose the solution for a worktree; null returns it to automatic detection. */
export function setCSharpSolution(wtPath: string, solutionPath: string | null): void {
  const key = csharpSolutionStoreKey(wtPath);
  if (solutionPath === null) deleteStore(key);
  else putStore(key, JSON.stringify({ solutionPath }));
}

/** Call `listener` with the worktree path whenever a worktree's choice is set or cleared. */
export function onCSharpSolutionChange(listener: (wtPath: string) => void): () => void {
  return onStoreChange((key) => {
    if (key.startsWith(KEY_PREFIX)) listener(key.slice(KEY_PREFIX.length));
  });
}
