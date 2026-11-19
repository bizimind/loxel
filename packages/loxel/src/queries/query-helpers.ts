import type { QueryClient } from "@tanstack/react-query";

import type { WorktreeRef } from "@/api/worktree-ref";
import { toAbsoluteDir } from "@/lib/detached-path";
import { queryClient } from "@/query-client";

import { isDirContentsKeyBelow, queryKeys } from "./query-keys";
import { projectRefOf } from "./use-scope";

/**
 * Refresh the listings of `absDirs` of worktree `wt` (one an operation captured when it started,
 * not whichever is active when it ends). Relative dirs are below `wt`.
 */
export function invalidateDirQueries(wt: WorktreeRef, ...absDirs: string[]) {
  const project = projectRefOf(wt);
  if (!project) return;
  for (const dir of absDirs) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dirContents(project, toAbsoluteDir(dir, wt.path)),
    });
  }
}

/** Forget the listings of `dir` of worktree `wt` and of everything below it. */
export function removeDirQueries(qc: QueryClient, wt: WorktreeRef, dir: string) {
  const project = projectRefOf(wt);
  if (!project) return;
  const absDir = toAbsoluteDir(dir, wt.path);
  qc.removeQueries({
    predicate: ({ queryKey }) => isDirContentsKeyBelow(queryKey, project, absDir),
  });
}
