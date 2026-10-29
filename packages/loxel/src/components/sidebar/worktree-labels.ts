import type { WorktreeEntry } from "@/api/git-models";
import { dayjs } from "@/lib/dayjs";
import { abbreviateHomePath } from "@/lib/home-path";

/** The worktree's own name, as `wt` knows it. */
export function worktreeName(wt: WorktreeEntry): string {
  return wt.wtName ?? wt.branch ?? wt.path.split("/").pop() ?? "worktree";
}

/** The name the sidebar shows: the title when one is set. */
export function worktreeLabel(wt: WorktreeEntry): string {
  return wt.title ?? worktreeName(wt);
}

/** The expanded row's second line: when the worktree was created, else where it is. */
export function worktreeSubtitle(wt: WorktreeEntry, homeDir: string | null): string {
  if (wt.pending === "creating") return "Creating...";
  if (wt.pending === "removing") return "Removing...";
  if (wt.createdAt) return dayjs(wt.createdAt).fromNow();
  return abbreviateHomePath(wt.path, homeDir);
}
