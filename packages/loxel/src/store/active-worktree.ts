import { useWorktreeStore } from "./worktrees";

/** Read the active worktree path synchronously. Throws if none is set. */
export function getActiveWt(): string {
  const wt = useWorktreeStore.getState().activeWorktreePath;
  if (!wt) throw new Error("No active worktree");
  return wt;
}
