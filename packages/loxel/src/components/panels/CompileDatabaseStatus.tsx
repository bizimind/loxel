import { skipToken, useQuery } from "@tanstack/react-query";

import {
  getCompileDatabaseStatus,
  getFileCompileDatabase,
} from "@/api/c-cpp-compile-database-client";
import { cCppToolchain } from "@/api/c-cpp-compile-database-model";
import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import {
  compileDatabaseSummary,
  compileDatabaseTooltip,
  selectCompileDatabase,
} from "@/lib/c-cpp-compile-database";
import { resolveLanguage } from "@/lib/resolve-language";
import { queryKeys } from "@/queries/query-keys";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";
import { deriveProject, useProjectStore } from "@/store/projects";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * The compile database clangd uses for the active editor's file, shown while that editor holds a C,
 * C++ or Objective-C file. Clicking it opens the picker for that file's worktree.
 */
export function CompileDatabaseStatusItem() {
  const active = useActiveToolchainStatus(cCppToolchain, getCompileDatabaseStatus);
  const filePath = useActiveEditorFile()?.filePath ?? null;
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const worktreePath = active?.wtPath ?? null;
  const projectPath = useProjectStore((s) => deriveProject(worktreePath, s.projects)?.path ?? null);
  const { data: file } = useQuery({
    // Extends the status's key, so that its changed message refreshes this too.
    queryKey: [...queryKeys.toolchainStatus(cCppToolchain.id, projectPath, worktreePath), filePath],
    queryFn:
      worktreePath && filePath
        ? () => getFileCompileDatabase({ worktreePath, filePath })
        : skipToken,
  });

  if (!active || !file || !filePath) return null;

  const { wtPath, status } = active;
  const languageId = resolveLanguage(filePath, associations) ?? "";
  const { label, warning } = compileDatabaseSummary(languageId, wtPath, status, file);
  return (
    <ToolchainStatusButton
      label={label}
      tooltip={compileDatabaseTooltip(wtPath, status, file)}
      warning={warning}
      onSelect={() => void selectCompileDatabase(wtPath)}
    />
  );
}
