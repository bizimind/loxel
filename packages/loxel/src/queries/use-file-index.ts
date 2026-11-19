import { useQuery } from "@tanstack/react-query";

import * as api from "@/api/client";
import type { WorktreeRef } from "@/api/worktree-ref";

import { queryKeys } from "./query-keys";
import { useProjectRef } from "./use-scope";

/**
 * Every file of worktree `wt` (`GET /api/file-index`), read again each time a reader asks for it,
 * as no event says when files come or go: Quick Open on each open, a terminal when it mounts.
 * Cached data shows meanwhile.
 */
export function useFileIndexQuery(wt: WorktreeRef | null) {
  const project = useProjectRef(wt);
  return useQuery({
    queryKey: queryKeys.fileIndex(project, wt),
    queryFn: () => {
      if (!wt) throw new Error("No worktree to index");
      return api.getFileIndex(wt.path);
    },
    enabled: wt !== null && project !== null,
    staleTime: 0,
  });
}
