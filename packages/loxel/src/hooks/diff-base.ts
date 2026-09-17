import type { CommitInfo } from "@/api/git-models";

/**
 * Where a diff of the selected commits should start from.
 *
 * The first parent of the oldest selected commit is the obvious answer and the
 * wrong one once the selection reaches the bottom of the branch: that parent
 * sits on the default branch *before* anything this branch later merged in, so
 * the diff re-reports every change the default branch made in between. On a
 * branch that had merged origin/main twice that was 170 unrelated files — 217
 * shown where the pull request had 47.
 *
 * The branch's merge base is the newest commit the two sides share, which is
 * what a pull request compares against. A selection that stops short of the
 * bottom is a genuine sub-range, so the parent of its oldest commit is still
 * right there. `branchCommits` is capped by the endpoint's limit, so on a
 * branch longer than that a full selection falls back to the parent as well.
 */
export function resolveDiffBase(
  oldest: CommitInfo,
  branchCommits: CommitInfo[],
  mergeBase: string | null | undefined,
): string | undefined {
  const oldestOfBranch = branchCommits[branchCommits.length - 1];
  if (mergeBase && oldestOfBranch?.hash === oldest.hash) return mergeBase;
  return oldest.parents[0];
}
