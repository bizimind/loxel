import type { DockviewPanelApi } from "dockview-react";
import { useEffect, useState } from "react";

export function usePanelActive(panelApi: DockviewPanelApi | undefined): boolean {
  const [isActive, setIsActive] = useState(() => panelApi?.isActive ?? true);

  useEffect(() => {
    if (!panelApi) return;
    setIsActive(panelApi.isActive);
    const disposable = panelApi.onDidActiveChange((e: { isActive: boolean }) =>
      setIsActive(e.isActive),
    );
    return () => disposable.dispose();
  }, [panelApi]);

  return isActive;
}
