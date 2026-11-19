import { useEffect, useState } from "react";

import { sameWorktreeRef, type WorktreeRef } from "@/api/worktree-ref";
import { type ActiveEditorFile, getActiveEditorFile } from "@/lib/reveal-in-explorer";
import { getCenterApi, subscribeCenterApi } from "@/store/tools-bar";

/**
 * The file shown by the active center panel and that panel's worktree, or null when the panel is
 * not a file editor.
 */
export function useActiveEditorFile(): ActiveEditorFile | null {
  const [centerApi, setCenterApiState] = useState(() => getCenterApi());
  const [activeEditorFile, setActiveEditorFile] = useState(() => getActiveEditorFile());
  useEffect(() => subscribeCenterApi(setCenterApiState), []);

  useEffect(() => {
    if (!centerApi) {
      setActiveEditorFile(null);
      return;
    }
    const updateActiveEditorFile = () =>
      setActiveEditorFile((current) => {
        const next = getActiveEditorFile();
        const same =
          current?.editorKey === next?.editorKey &&
          sameOptionalWorktree(current?.worktree ?? null, next?.worktree ?? null);
        return same ? current : next;
      });
    updateActiveEditorFile();
    const disposable = centerApi.onDidActivePanelChange(updateActiveEditorFile);
    return () => disposable.dispose();
  }, [centerApi]);

  return activeEditorFile;
}

/** The file shown by the active center panel, or null when that panel is not a file editor. */
export function useActiveEditorFilePath(): string | null {
  return useActiveEditorFile()?.filePath ?? null;
}

function sameOptionalWorktree(a: WorktreeRef | null, b: WorktreeRef | null): boolean {
  return a === null || b === null ? a === b : sameWorktreeRef(a, b);
}
