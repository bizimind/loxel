import { useEffect, useState } from "react";

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
          current?.filePath === next?.filePath && current?.worktreePath === next?.worktreePath;
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
