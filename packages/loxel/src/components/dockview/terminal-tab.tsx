import type { IDockviewPanelHeaderProps } from "dockview-react";

import { SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { NotificationDot } from "@/components/ui/notification-dot";
import { hasPanelNotification, usePanelNotificationStore } from "@/store/panel-notifications";

import { Tab } from "./tab";

export function TerminalTab(props: IDockviewPanelHeaderProps<{ terminalId: string }>) {
  const terminalId = props.params.terminalId;
  const hasNotification = usePanelNotificationStore((s) => hasPanelNotification(s, terminalId));
  const [isActive, setIsActive] = useState(props.api.isActive);

  useEffect(() => {
    if (props.api.isActive) {
      usePanelNotificationStore.getState().dismissPanel(terminalId);
    }
    const disposable = props.api.onDidActiveChange((e) => {
      setIsActive(e.isActive);
      if (e.isActive) {
        usePanelNotificationStore.getState().dismissPanel(terminalId);
      }
    });
    return () => disposable.dispose();
  }, [props.api, terminalId]);

  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative shrink-0">
          <SquareTerminalIcon className="size-3.5" />
          {hasNotification && !isActive && <NotificationDot />}
        </span>
      }
      title={props.api.title || "Terminal"}
    />
  );
}
