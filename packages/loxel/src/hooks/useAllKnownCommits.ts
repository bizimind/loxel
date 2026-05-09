import { useMemo } from "react";

import type { CommitInfo } from "@/api/git-models";

import { useCommitsWithUncommitted } from "@/hooks/useCommitsWithUncommitted";
import { injectUncommittedCommits } from "@/lib/uncommitted-commits";
import { useBranchCommitsQuery, useWorktreeStatusesQuery } from "@/queries/use-repo-queries";

/**
 * Merges main graph commits with branch dropdown commits for unified lookup.
 * Branch commits also get virtual uncommitted entries injected so the same
 * lookup logic works for both graph and dropdown selections.
 */
export function useAllKnownCommits(): CommitInfo[] {
  const enrichedCommits = useCommitsWithUncommitted();
  const { data: branchData } = useBranchCommitsQuery();
  const { data: worktreeStatuses } = useWorktreeStatusesQuery();

  return useMemo(() => {
    const branchCommits = branchData?.commits ?? [];
    if (branchCommits.length === 0) return enrichedCommits;
    const enrichedBranch = injectUncommittedCommits(branchCommits, worktreeStatuses ?? []);
    const seen = new Set(enrichedCommits.map((c) => c.hash));
    const extra = enrichedBranch.filter((c) => !seen.has(c.hash));
    return extra.length > 0 ? [...enrichedCommits, ...extra] : enrichedCommits;
  }, [enrichedCommits, branchData, worktreeStatuses]);
}
