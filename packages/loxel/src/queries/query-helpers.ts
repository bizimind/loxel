import type { QueryClient } from "@tanstack/react-query";

import { toAbsoluteDir } from "@/lib/detached-path";
import { queryClient } from "@/query-client";

import { isDirContentsKeyBelow, queryKeys } from "./query-keys";
import { getQueryScope } from "./use-scope";

export function invalidateDirQueries(...absDirs: string[]) {
  const { activeProject, activeWorktree } = getQueryScope();
  for (const dir of absDirs) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dirContents(
        activeProject,
        toAbsoluteDir(dir, activeWorktree?.path ?? null),
      ),
    });
  }
}

export function removeDirQueries(qc: QueryClient, dir: string) {
  const { activeProject, activeWorktree } = getQueryScope();
  const absDir = toAbsoluteDir(dir, activeWorktree?.path ?? null);
  qc.removeQueries({
    predicate: ({ queryKey }) => isDirContentsKeyBelow(queryKey, activeProject, absDir),
  });
}
