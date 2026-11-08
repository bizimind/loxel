/** The rows `stores.db` keeps per worktree: its layouts, Others folders and toolchain choices. */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { layoutKeyWorktree } from "@/lib/layout-key-schema";
import { isWithin } from "@/lib/project-file-helpers";

import { externalFoldersStoreKey } from "./external-folders-service";
import { deleteStore, listStoreKeys } from "./store-db";
import { toolchainStatusModules } from "./toolchain-statuses";

const WORKTREE_KEY_PREFIXES = [
  externalFoldersStoreKey,
  ...toolchainStatusModules.map((module) => module.overrideStoreKey),
].map((keyOf) => keyOf("/").slice(0, -1));

/** The worktree a row belongs to, or null for a row that is not per worktree. */
function rowWorktree(key: string): string | null {
  const prefix = WORKTREE_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
  return prefix === undefined ? layoutKeyWorktree(key) : key.slice(prefix.length);
}

/**
 * A worktree recreated at the same path starts fresh. Trust and declined rows are keyed by repository,
 * not by worktree, so they stay.
 */
export function deleteWorktreeRows(wtPath: string): void {
  for (const key of listStoreKeys()) {
    if (rowWorktree(key) === wtPath) deleteStore(key);
  }
}

/**
 * Delete the rows of worktrees removed while no server was watching, and return their paths: every
 * worktree with rows under `worktreesDir` that is neither registered nor on disk. With the
 * directory itself gone (a `WT_DIR` on a volume not mounted now) nothing can be told.
 */
export function deleteRowsOfMissingWorktrees(
  worktreesDir: string,
  registered: ReadonlySet<string>,
): string[] {
  const missing = new Set<string>();
  if (!existsSync(worktreesDir)) return [];
  for (const key of listStoreKeys()) {
    const wtPath = rowWorktree(key);
    if (!wtPath || !isWithin(wtPath, worktreesDir) || wtPath === worktreesDir) continue;
    if (registered.has(wtPath) || existsSync(wtPath)) continue;
    missing.add(wtPath);
    deleteStore(key);
  }
  return [...missing];
}

/**
 * Whether `key` is the layout row of a worktree that is gone. A window goes on saving the layout it
 * shows for a moment after the worktree is removed (a pending save, the save on the way out of the
 * layout), and any of those writes would bring back the rows the removal deleted.
 */
export function isLayoutRowOfMissingWorktree(key: string): boolean {
  const wtPath = layoutKeyWorktree(key);
  // Not a path: the layout shown with no worktree active.
  return wtPath !== null && isAbsolute(wtPath) && !existsSync(wtPath);
}
