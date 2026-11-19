import { useQuery } from "@tanstack/react-query";

import * as api from "@/api/client";
import type { WorktreeRef } from "@/api/worktree-ref";

import { queryKeys } from "./query-keys";
import { useProjectRef } from "./use-scope";

/**
 * Every file of worktree `wt` (`GET /api/file-index`), cached under its ref. No event says when
 * files come or go, so a reader that wants the current list asks with `fresh` (Quick Open, on each
 * open), and gets it in the background with the cached one shown meanwhile; others (terminal
 * links) take what is cached, reading it only when nothing is. Only a worktree of a server the
 * window is connected to is read, since the request goes to that connection.
 */
export function useFileIndexQuery(wt: WorktreeRef | null, { fresh = false } = {}) {
  const project = useProjectRef(wt);
  return useQuery({
    queryKey: queryKeys.fileIndex(project, wt),
    queryFn: () => {
      if (!wt) throw new Error("No worktree to index");
      return api.getFileIndex(wt.path);
    },
    enabled: wt !== null && project !== null && api.hasConnection(wt.server),
    staleTime: fresh ? 0 : Number.POSITIVE_INFINITY,
  });
}
