import type { QueryClient } from "@tanstack/react-query";

import { useCallback, useState } from "react";

import type { DirEntry } from "@/api/project-files-model";

import * as api from "@/api/client";
import { showToast } from "@/components/ui/toast";
import { toAbsoluteDir } from "@/lib/detached-path";
import { fileParentDir, pathName } from "@/lib/project-file-helpers";
import { invalidateDirQueries } from "@/queries/query-helpers";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

export function useFileClipboard(
  isDetachedPath: (path: string) => boolean,
  queryClient: QueryClient,
  activeWorktreePath: string | null,
) {
  const [clipboard, setClipboard] = useState<{ path: string; mode: "cut" | "copy" } | null>(null);

  const handleCut = useCallback((path: string) => {
    setClipboard({ path, mode: "cut" });
  }, []);

  const handleCopyFile = useCallback((path: string) => {
    setClipboard({ path, mode: "copy" });
  }, []);

  const handlePaste = useCallback(
    async (targetDir: string) => {
      if (!clipboard) return;
      try {
        const wt = useWorktreeStore.getState().activeWorktreePath;
        if (!wt) return;

        if (isDetachedPath(clipboard.path)) {
          if (clipboard.mode === "cut") {
            const { newPath } = await api.moveDetachedFileToProject({
              wt,
              path: clipboard.path,
              destPath: targetDir,
            });
            window.dispatchEvent(
              new CustomEvent("loxel-file-moved", { detail: { oldPath: clipboard.path, newPath } }),
            );
          } else {
            const { newPath } = await api.copyDetachedFileToProject({
              wt,
              path: clipboard.path,
              destPath: targetDir,
            });
            getCurrentWorktreeUI().getState().setSelectedProjectFile(newPath);
          }
        } else if (clipboard.mode === "cut") {
          const { newPath } = await api.moveProjectFile(wt, {
            srcPath: clipboard.path,
            destDir: targetDir,
          });
          getCurrentWorktreeUI().getState().renameProjectPaths(clipboard.path, newPath);
          window.dispatchEvent(
            new CustomEvent("loxel-file-moved", { detail: { oldPath: clipboard.path, newPath } }),
          );
          const srcParentDir = fileParentDir(clipboard.path, wt);
          const destDirAbs = targetDir || wt;
          invalidateDirQueries(srcParentDir, destDirAbs);
        } else {
          const { newPath } = await api.copyProjectFile(wt, {
            srcPath: clipboard.path,
            destDir: targetDir,
          });
          getCurrentWorktreeUI().getState().setSelectedProjectFile(newPath);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Paste failed");
      }
      setClipboard(null);
    },
    [clipboard, isDetachedPath],
  );

  const resolveTargetDir = useCallback(
    (selected: string) => {
      if (activeWorktreePath && selected === activeWorktreePath) return activeWorktreePath;
      const parentDirPath = fileParentDir(selected, activeWorktreePath);
      const entryName = pathName(selected);
      const { activeProjectPath: projectPath } = getQueryScope();
      const absDirPath = toAbsoluteDir(parentDirPath, activeWorktreePath);
      const parentEntries = queryClient.getQueryData<DirEntry[]>(
        queryKeys.dirContents(projectPath, absDirPath),
      );
      const isDir = parentEntries?.find((entry) => entry.name === entryName)?.isDir ?? false;
      return isDir ? selected : parentDirPath;
    },
    [queryClient, activeWorktreePath],
  );

  const cutPath = clipboard?.mode === "cut" ? clipboard.path : null;

  return { clipboard, cutPath, handleCut, handleCopyFile, handlePaste, resolveTargetDir };
}
