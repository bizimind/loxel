import { HOME_KEY } from "@/api/home-model";
import { localServerId } from "@/api/local-server";
import { type WorktreeRef, worktreeRef } from "@/api/worktree-ref";

import { useWorktreeStore } from "./worktrees";

/**
 * The layout key of Home, the layout a window shows while no worktree is active. Worktree layouts
 * are keyed by absolute path, so this never names one.
 */
export const HOME_LAYOUT_KEY = HOME_KEY;

/** The key of the layout the window shows: the active worktree's path, or Home's. */
export function activeLayoutKey(): string {
  return useWorktreeStore.getState().activeWorktree?.path ?? HOME_LAYOUT_KEY;
}

/**
 * A worktree path a layout holds, as its key or in a panel's `worktreePath` param, as a ref. A
 * layout is stored on the server that holds its worktree, the window's, and keeps bare paths.
 */
export function layoutWorktreeRef(path: string): WorktreeRef {
  return worktreeRef(localServerId(), path);
}

/** The worktree of a layout key; null for Home's. */
export function layoutWorktree(layoutKey: string): WorktreeRef | null {
  return layoutKey === HOME_LAYOUT_KEY ? null : layoutWorktreeRef(layoutKey);
}
