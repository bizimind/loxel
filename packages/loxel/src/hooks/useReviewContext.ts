import { useMemo } from "react";

import type { ReviewContext } from "@/api/review-model";
import { useCommitsQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeUI } from "@/store/worktree-ui";

/**
 * Computes the ReviewContext and default review name from the current diff source.
 * Used by CommentsPanel (header ReviewSelector).
 *
 * `parentHash` here is a best-effort label for naming a review, not the base a
 * diff is rendered against. It can be a symbolic ref, and the commit lookup can
 * miss when the commit is outside the current branch filter. The base used for
 * rendering comes from `DiffInfo.baseRef`, which the server resolves.
 */
export function useReviewContext(): {
  reviewContext: ReviewContext;
  reviewDefaultName: string;
  commitHash: string | undefined;
  parentHash: string | undefined;
  worktreePath: string | undefined;
} {
  const diffSource = useRepositoryStore((s) => s.diffSource);
  const branchFilterPreset = useWorktreeUI((s) => s.branchFilterPreset);
  const { data: commitsData } = useCommitsQuery(branchFilterPreset);
  const commits = commitsData?.commits ?? [];

  return useMemo(() => {
    let commitHash: string | undefined;
    let parentHash: string | undefined;
    let worktreePath: string | undefined;

    if (diffSource?.type === "uncommitted") {
      worktreePath = diffSource.worktree;
      parentHash = diffSource.base ?? "HEAD";
    } else if (diffSource?.type === "commit") {
      commitHash = diffSource.commit;
      parentHash = commits.find((c) => c.hash === diffSource.commit)?.parents[0];
    } else if (diffSource?.type === "range" && diffSource.range) {
      [parentHash, commitHash] = diffSource.range.split(/\.{2,3}/);
    }

    const commitHashes: string[] = [];
    if (commitHash) commitHashes.push(commitHash);
    if (parentHash && parentHash !== "HEAD") commitHashes.push(parentHash);

    const reviewContext: ReviewContext = {
      commitHashes,
      branchName: null,
      headCommit: commitHash ?? parentHash ?? "",
      worktreePath: worktreePath ?? null,
    };

    let reviewDefaultName = "New Review";
    if (worktreePath) reviewDefaultName = "Review of uncommitted changes";
    else if (commitHash && parentHash)
      reviewDefaultName = `Review of ${parentHash.slice(0, 7)}..${commitHash.slice(0, 7)}`;
    else if (commitHash) reviewDefaultName = `Review of ${commitHash.slice(0, 7)}`;

    return { reviewContext, reviewDefaultName, commitHash, parentHash, worktreePath };
  }, [diffSource, commits]);
}
