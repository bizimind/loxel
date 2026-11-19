import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useState } from "react";

import { hasPanelNotification, usePanelNotificationStore } from "@/store/panel-notifications";

import { useLayoutServer } from "./panel-context";

/**
 * Whether a tab shows its panel's notification dot: the panel (`panelId`, its notification
 * source id, on the server of the panel's layout) has notifications and the tab is not active.
 * Activating the tab dismisses them.
 */
export function usePanelNotificationDot(
  { api }: Pick<IDockviewPanelHeaderProps, "api">,
  panelId: string,
): boolean {
  // A tab header is outside its panel's context, but in its layout, whose server holds the panel.
  const server = useLayoutServer();
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
