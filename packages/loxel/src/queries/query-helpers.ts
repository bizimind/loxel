import type { QueryClient } from "@tanstack/react-query";

import { toAbsoluteDir } from "@/lib/detached-path";
import { queryClient } from "@/query-client";

import { queryKeys } from "./query-keys";
import { getQueryScope } from "./use-scope";

export function invalidateDirQueries(...absDirs: string[]) {
  const { activeProjectPath, activeWorktreePath } = getQueryScope();
  for (const dir of absDirs) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dirContents(activeProjectPath, toAbsoluteDir(dir, activeWorktreePath)),
    });
  }
}

export function removeDirQueries(qc: QueryClient, dir: string) {
  const { activeProjectPath: projectPath, activeWorktreePath: wtPath } = getQueryScope();
  const absDir = toAbsoluteDir(dir, wtPath);
  qc.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] !== "dirContents" || key[1] !== projectPath) return false;
      const qDir = key[2];
      if (typeof qDir !== "string") return false;
      if (qDir === absDir) return true;
      return qDir.startsWith(absDir + "/");
    },
  });
}
