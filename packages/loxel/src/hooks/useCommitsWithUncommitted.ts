import { useMemo } from "react";

import type { CommitInfo } from "@/api/git-models";
import { injectUncommittedCommits } from "@/lib/uncommitted-commits";
import { useCommitsQuery, useWorktreeStatusesQuery } from "@/queries/use-repo-queries";
import { useWorktreeUI } from "@/store/worktree-ui";

/**
 * Returns the commit list with virtual "uncommitted changes" rows injected.
 */
export function useCommitsWithUncommitted(): CommitInfo[] {
  const preset = useWorktreeUI((s) => s.branchFilterPreset);
  const { data: commitsData } = useCommitsQuery(preset);
  const { data: worktreeStatuses } = useWorktreeStatusesQuery();
  const commits = commitsData?.commits ?? [];

  return useMemo(
    () => injectUncommittedCommits(commits, worktreeStatuses ?? []),
    [commits, worktreeStatuses],
  );
}
