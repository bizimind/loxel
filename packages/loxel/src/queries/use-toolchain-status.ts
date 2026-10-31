import { skipToken, useQuery } from "@tanstack/react-query";

import type { ToolchainStatusDescriptor } from "@/api/toolchain-status-model";
import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import { resolveLanguage } from "@/lib/resolve-language";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { deriveProject, useProjectStore } from "@/store/projects";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

/**
 * The toolchain status of the active editor's worktree (the panel's own, which is not always the
 * active worktree), while that editor holds a file of one of the toolchain's languages; null
 * otherwise and until it loads.
 */
export function useActiveToolchainStatus<Status>(
  toolchain: ToolchainStatusDescriptor,
  fetchStatus: (wtPath: string) => Promise<Status>,
): { wtPath: string; status: Status } | null {
  const active = useActiveEditorFile();
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const language = active && resolveLanguage(active.filePath, associations);
  const wtPath =
    active && language && toolchain.languageIds.includes(language) ? active.worktreePath : null;
  const projectPath = useProjectStore((s) => deriveProject(wtPath, s.projects)?.path ?? null);
  const { data } = useQuery({
    queryKey: queryKeys.toolchainStatus(toolchain.id, projectPath, wtPath),
    queryFn: wtPath ? () => fetchStatus(wtPath) : skipToken,
    staleTime: Infinity, // WebSocket bridge invalidates it on the toolchain's changed message
  });
  return wtPath && data ? { wtPath, status: data } : null;
}

/** Puts what a picker's change returned in the cache, for the status item to show at once. */
export function setToolchainStatusData(
  toolchain: ToolchainStatusDescriptor,
  wtPath: string,
  status: unknown,
): void {
  const projectPath = deriveProject(wtPath, useProjectStore.getState().projects)?.path ?? null;
  queryClient.setQueryData(queryKeys.toolchainStatus(toolchain.id, projectPath, wtPath), status);
}
