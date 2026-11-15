import { HOME_KEY } from "@/api/home-model";

import { useWorktreeStore } from "./worktrees";

/**
 * The layout key of Home, the layout a window shows while no worktree is active. Worktree layouts
 * are keyed by absolute path, so this never names one.
 */
export const HOME_LAYOUT_KEY = HOME_KEY;

/** Read the active worktree path synchronously. Throws if none is set. */
export function getActiveWt(): string {
  const wt = useWorktreeStore.getState().activeWorktreePath;
  if (!wt) throw new Error("No active worktree");
  return wt;
}

/** The key of the layout the window shows: the active worktree's path, or Home's. */
export function activeLayoutKey(): string {
  return useWorktreeStore.getState().activeWorktreePath ?? HOME_LAYOUT_KEY;
}
