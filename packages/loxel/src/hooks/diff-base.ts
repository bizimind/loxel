import type { BranchCommits, CommitInfo } from "@/api/git-models";

/**
 * A selection of commits to diff. `newest` is null when the selection extends
 * to the working tree, which always sits on top of the branch tip.
 */
export interface DiffSelection {
  oldest: CommitInfo;
  newest: CommitInfo | null;
}

/**
 * Where a diff of the selected commits should start from.
 *
 * The first parent of the oldest selected commit is the obvious answer and the
 * wrong one once the selection is the whole branch: that parent sits on the
 * default branch *before* anything this branch later merged in, so the diff
 * re-reports every change the default branch made in between. On a branch that
 * had merged origin/main twice that was 170 unrelated files — 217 shown where
 * the pull request had 47.
 *
 * The branch's merge base is the newest commit the two sides share, which is
 * what a pull request compares against. It is only a valid base for a diff
 * that ends at the branch tip, though: the merge base need not be an ancestor
 * of an older commit, and a two-dot diff from it would then show the default
 * branch's changes as deletions. Any selection that stops short of the tip or
 * of the bottom is a genuine sub-range, so the parent of its oldest commit is
 * still right there. That includes a full selection of a truncated list, where
 * the listed bottom is not the branch's bottom.
 */
export function resolveDiffBase(
  selection: DiffSelection,
  branch: BranchCommits | undefined,
): string | undefined {
  if (branch?.mergeBase && isWholeBranch(selection, branch)) return branch.mergeBase;
  return selection.oldest.parents[0];
}

function isWholeBranch({ oldest, newest }: DiffSelection, branch: BranchCommits): boolean {
  if (branch.truncated) return false;
  const tip = branch.commits[0];
  const bottom = branch.commits[branch.commits.length - 1];
  if (bottom?.hash !== oldest.hash) return false;
  return newest === null || tip?.hash === newest.hash;
}
