import { useEffect, useState } from "react";

import { getActiveEditorFilePath } from "@/lib/reveal-in-explorer";
import { getCenterApi, subscribeCenterApi } from "@/store/tools-bar";

/** The file shown by the active center panel, or null when that panel is not a file editor. */
export function useActiveEditorFilePath(): string | null {
  const [centerApi, setCenterApiState] = useState(() => getCenterApi());
  const [activeEditorFilePath, setActiveEditorFilePath] = useState(() => getActiveEditorFilePath());
  useEffect(() => subscribeCenterApi(setCenterApiState), []);

  useEffect(() => {
    if (!centerApi) {
      setActiveEditorFilePath(null);
      return;
    }
    const updateActiveEditorFilePath = () => setActiveEditorFilePath(getActiveEditorFilePath());
    updateActiveEditorFilePath();
    const disposable = centerApi.onDidActivePanelChange(updateActiveEditorFilePath);
    return () => disposable.dispose();
  }, [centerApi]);

  return activeEditorFilePath;
}
