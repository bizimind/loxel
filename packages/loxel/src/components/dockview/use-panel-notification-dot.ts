import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useState } from "react";

import { localServerId } from "@/api/local-server";
import { hasPanelNotification, usePanelNotificationStore } from "@/store/panel-notifications";

import { getPanelServer } from "./panel-context";

/**
 * Whether a tab shows its panel's notification dot: the panel (`panelId`, its notification
 * source id, on the server holding the panel) has notifications and the tab is not active.
 * Activating the tab dismisses them.
 */
export function usePanelNotificationDot(
  { api, containerApi }: Pick<IDockviewPanelHeaderProps, "api" | "containerApi">,
  panelId: string,
): boolean {
  const panel = containerApi.getPanel(api.id);
  const server = panel ? getPanelServer(panel) : localServerId();
  const hasNotification = usePanelNotificationStore((s) =>
    hasPanelNotification(s, server, panelId),
  );
  const [isActive, setIsActive] = useState(api.isActive);

  useEffect(() => {
    if (api.isActive) {
      usePanelNotificationStore.getState().dismissPanel(server, panelId);
    }
    const disposable = api.onDidActiveChange((e) => {
      setIsActive(e.isActive);
      if (e.isActive) {
        usePanelNotificationStore.getState().dismissPanel(server, panelId);
      }
    });
    return () => disposable.dispose();
  }, [api, server, panelId]);

  return hasNotification && !isActive;
}
