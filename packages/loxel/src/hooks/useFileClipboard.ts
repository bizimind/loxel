import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import * as api from "@/api/client";
import type { DirEntry } from "@/api/project-files-model";
import type { WorktreeRef } from "@/api/worktree-ref";
import { showToast } from "@/components/ui/toast";
import { toAbsoluteDir } from "@/lib/detached-path";
import { moveFile } from "@/lib/file-operations";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { fileParentDir, pathName } from "@/lib/project-file-helpers";
import { queryKeys } from "@/queries/query-keys";
import { getQueryScope } from "@/queries/use-scope";
import { getWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

/** A cut or copied file: its path on the server of `source`, the worktree it was taken in. */
interface FileClipboard {
  source: WorktreeRef;
  path: string;
  mode: "cut" | "copy";
}

/**
 * @param getTreeRoot The root of the tree that shows a path: the worktree or an Others folder.
 *   Moves and copies stay within one tree.
 */
export function useFileClipboard(
  isDetachedPath: (path: string) => boolean,
  queryClient: QueryClient,
  activeWorktreePath: string | null,
  getTreeRoot: (path: string) => string | null,
) {
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);

  const handleCut = useCallback((path: string) => {
    const source = getQueryScope().activeWorktree;
    if (source) setClipboard({ source, path, mode: "cut" });
  }, []);

  const handleCopyFile = useCallback((path: string) => {
    const source = getQueryScope().activeWorktree;
    if (source) setClipboard({ source, path, mode: "copy" });
  }, []);

  const handlePaste = useCallback(
    async (targetDir: string) => {
      if (!clipboard) return;
      try {
        const { activeWorktree } = getQueryScope();
        if (!activeWorktree) return;
        // The path is on its source's server: another server's file is not there to move.
        if (clipboard.source.server !== activeWorktree.server) {
          showToast("Can't move or copy between servers");
          return;
        }
        const wt = activeWorktree.path;

        // Drafts move into the worktree only; everything else stays within its own tree.
        const sourceRoot = isDetachedPath(clipboard.path) ? wt : getTreeRoot(clipboard.path);
        if (sourceRoot !== getTreeRoot(targetDir || wt)) {
          showToast("Can't move or copy between the project and other folders");
          return;
        }

        if (isDetachedPath(clipboard.path)) {
          if (clipboard.mode === "cut") {
            const { newPath } = await api.moveDetachedFileToProject(activeWorktree, {
              path: clipboard.path,
              destPath: targetDir,
            });
            dispatchLoxelEvent("loxel-file-moved", {
              server: activeWorktree.server,
              oldPath: clipboard.path,
              newPath,
            });
          } else {
            const { newPath } = await api.copyDetachedFileToProject(activeWorktree, {
              path: clipboard.path,
              destPath: targetDir,
            });
            getWorktreeUI(activeWorktree).getState().setSelectedProjectFile(newPath);
          }
        } else if (clipboard.mode === "cut") {
          await moveFile({ wt: activeWorktree, srcPath: clipboard.path, destDir: targetDir });
        } else {
          const { newPath } = await api.copyProjectFile(activeWorktree, {
            srcPath: clipboard.path,
            destDir: targetDir,
          });
          getWorktreeUI(activeWorktree).getState().setSelectedProjectFile(newPath);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Paste failed");
      }
      setClipboard(null);
    },
    [clipboard, isDetachedPath, getTreeRoot],
  );

  const resolveTargetDir = useCallback(
    (selected: string) => {
      if (getTreeRoot(selected) === selected) return selected;
      const parentDirPath = fileParentDir(selected, activeWorktreePath);
      const entryName = pathName(selected);
      const { activeProject } = getQueryScope();
      const absDirPath = toAbsoluteDir(parentDirPath, activeWorktreePath);
      const parentEntries = queryClient.getQueryData<DirEntry[]>(
        queryKeys.dirContents(activeProject, absDirPath),
      );
      const isDir = parentEntries?.find((entry) => entry.name === entryName)?.isDir ?? false;
      return isDir ? selected : parentDirPath;
    },
    [queryClient, activeWorktreePath, getTreeRoot],
  );

  // Another server's file is not the one shown at the same path: no cut mark, nothing to paste.
  const activeServer = useWorktreeStore((s) => s.activeWorktree?.server);
  const shown = clipboard?.source.server === activeServer ? clipboard : null;
  const cutPath = shown?.mode === "cut" ? shown.path : null;

  return { clipboard: shown, cutPath, handleCut, handleCopyFile, handlePaste, resolveTargetDir };
}
