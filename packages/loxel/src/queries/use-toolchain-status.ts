import { skipToken, useQuery } from "@tanstack/react-query";

import type { ToolchainStatusDescriptor } from "@/api/toolchain-status-model";
import type { WorktreeRef } from "@/api/worktree-ref";
import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import { resolveLanguage } from "@/lib/resolve-language";
import { queryKeys } from "@/queries/query-keys";
import { projectRefOf, useProjectRef } from "@/queries/use-scope";
import { queryClient } from "@/query-client";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

/**
 * The toolchain status of the active editor's worktree (the panel's own, which is not always the
 * active worktree), while that editor holds a file of one of the toolchain's languages; null
 * otherwise and until it loads. `wtPath` is the worktree's path, which labels show.
 */
export function useActiveToolchainStatus<Status>(
  toolchain: ToolchainStatusDescriptor,
  fetchStatus: (wt: WorktreeRef) => Promise<Status>,
): { wt: WorktreeRef; wtPath: string; status: Status } | null {
  const active = useActiveEditorFile();
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const language = active && resolveLanguage(active.filePath, associations);
  const wt =
    active && language && toolchain.languageIds.includes(language) ? active.worktree : null;
  const project = useProjectRef(wt);
  const { data } = useQuery({
    queryKey: queryKeys.toolchainStatus(toolchain.id, project, wt),
    queryFn: wt ? () => fetchStatus(wt) : skipToken,
    staleTime: Infinity, // WebSocket bridge invalidates it on the toolchain's changed message
  });
  return wt && data ? { wt, wtPath: wt.path, status: data } : null;
}

/** Puts what a picker's change returned in the cache, for the status item to show at once. */
export function setToolchainStatusData(
  toolchain: ToolchainStatusDescriptor,
  wt: WorktreeRef,
  status: unknown,
): void {
  queryClient.setQueryData(queryKeys.toolchainStatus(toolchain.id, projectRefOf(wt), wt), status);
}
