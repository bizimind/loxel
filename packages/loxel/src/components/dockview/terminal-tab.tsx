import type { IDockviewPanelHeaderProps } from "dockview-react";
import { MessagesSquareIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentStateDot } from "@/components/agent-overlay/AgentStateDot";
import type { TerminalViewParams } from "@/components/agent-overlay/terminal-view";
import { setTerminalView, terminalView } from "@/components/agent-overlay/terminal-view";
import { NotificationDot } from "@/components/ui/notification-dot";
import { useAgentOverlayStore } from "@/store/agent-overlay";
import { hasPanelNotification, usePanelNotificationStore } from "@/store/panel-notifications";

import { Tab, usePanelTitle } from "./tab";

export function TerminalTab(
  props: IDockviewPanelHeaderProps<{ terminalId: string } & TerminalViewParams>,
) {
  const terminalId = props.params.terminalId;
  const agentState = useAgentOverlayStore((s) => s.sessions[terminalId]?.state);
  const view = terminalView(props.params);
  const hasNotification = usePanelNotificationStore((s) => hasPanelNotification(s, terminalId));
  const [isActive, setIsActive] = useState(props.api.isActive);
  const title = usePanelTitle(props.api);

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
      title={title || "Terminal"}
      onRename={(newName) => props.api.setTitle(newName)}
      leading={agentState && <AgentStateDot state={agentState} />}
      trailing={
        agentState && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-muted rounded p-0.5"
            title={view === "agent" ? "Show the raw terminal" : "Show the Claude Code view"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setTerminalView(props.api, view === "agent" ? "terminal" : "agent");
            }}
          >
            {view === "agent" ? (
              <SquareTerminalIcon className="size-3.5" />
            ) : (
              <MessagesSquareIcon className="size-3.5" />
            )}
          </button>
        )
      }
    />
  );
}
