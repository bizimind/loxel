import { useCallback, useMemo } from "react";

import { showToast } from "@/components/ui/toast";
import { isWithin } from "@/lib/project-file-helpers";
import { renameFile } from "@/lib/rename-file";
import { useDetachedFilesQuery, useExternalFilesQuery } from "@/queries/use-repo-queries";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Rename handler for a file-backed tab, or undefined when the file can't be renamed. Like the
 * project files tree, a tab can rename files in the active worktree, its Drafts and its Others
 * folders; individually opened Others files and files elsewhere are read-only.
 */
export function useFileTabRename(
  filePath: string,
): ((newName: string) => Promise<void>) | undefined {
  const wt = useWorktreeStore((s) => s.activeWorktreePath);
  const { data: detachedFiles } = useDetachedFilesQuery();
  const { data: otherEntries } = useExternalFilesQuery();

  const isDetached = useMemo(
    () => detachedFiles?.some((e) => e.path === filePath) ?? false,
    [detachedFiles, filePath],
  );
  const isRenameable = useMemo(
    () =>
      isDetached ||
      (wt !== null && isWithin(filePath, wt)) ||
      (otherEntries?.some((e) => e.isDir && isWithin(filePath, e.path)) ?? false),
    [isDetached, wt, filePath, otherEntries],
  );

  const handleRename = useCallback(
    async (newName: string) => {
      if (!wt) return;
      try {
        await renameFile({ wt, path: filePath, newName, isDetached });
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Rename failed");
      }
    },
    [wt, filePath, isDetached],
  );

  return isRenameable ? handleRename : undefined;
}
