import type { DockviewPanelApi } from "dockview-react";
import { useEffect, useState } from "react";

import { hasPanelNotification, usePanelNotificationStore } from "@/store/panel-notifications";

/**
 * Whether a tab shows its panel's notification dot: the panel (`panelId`, its notification
 * source id) has notifications and the tab is not active. Activating the tab dismisses them.
 */
export function usePanelNotificationDot(api: DockviewPanelApi, panelId: string): boolean {
  const hasNotification = usePanelNotificationStore((s) => hasPanelNotification(s, panelId));
  const [isActive, setIsActive] = useState(api.isActive);

  useEffect(() => {
    if (api.isActive) {
      usePanelNotificationStore.getState().dismissPanel(panelId);
    }
    const disposable = api.onDidActiveChange((e) => {
      setIsActive(e.isActive);
      if (e.isActive) {
        usePanelNotificationStore.getState().dismissPanel(panelId);
      }
    });
    return () => disposable.dispose();
  }, [api, panelId]);

  return hasNotification && !isActive;
}
