import { useEffect, useMemo } from "react";

import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { orderDiffFiles } from "@/lib/diff-file-tree";
import { useWorktreeUI } from "@/store/worktree-ui";

/**
 * The file the diff viewer shows, shared by the Changes panel and the diff viewer, and `files` in
 * Changes tree order. While no file or a file outside `files` is selected, the first file in that
 * order is selected.
 */
export function useDiffFileSelection(files: FileDiff[]) {
  const selectedFile = useWorktreeUI((s) => s.selectedDiffFile);
  const setSelectedFile = useWorktreeUI((s) => s.setSelectedDiffFile);
  const orderedFiles = useMemo(() => orderDiffFiles(files), [files]);

  useEffect(() => {
    if (selectedFile && orderedFiles.some((f) => fileDiffPath(f) === selectedFile)) return;
    const first = orderedFiles[0];
    setSelectedFile(first ? fileDiffPath(first) : null);
  }, [orderedFiles, selectedFile, setSelectedFile]);

  return { selectedFile, setSelectedFile, orderedFiles };
}
