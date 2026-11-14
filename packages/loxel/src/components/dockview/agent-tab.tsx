import type { IDockviewPanelHeaderProps } from "dockview-react";
import { BotIcon, LoaderIcon } from "lucide-react";

import { NotificationDot } from "@/components/ui/notification-dot";
import { useAgentStatusStore } from "@/store/agent-status";

import { Tab, usePanelTitle } from "./tab";

/** An agent panel's tab: a spinner while it works, a dot when it needs an answer. */
export function AgentTab(props: IDockviewPanelHeaderProps<{ agentId: string }>) {
  const status = useAgentStatusStore((s) => s.statuses[props.params.agentId]);
  const title = usePanelTitle(props.api);
  const tooltip = {
    starting: "Starting",
    idle: "Idle",
    working: "Working",
    needs_input: "Needs your input",
    failed: "Failed",
    exited: "Stopped",
  }[status ?? "starting"];

  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative shrink-0" title={tooltip}>
          {status === "working" ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <BotIcon className={status === "failed" ? "text-destructive size-3.5" : "size-3.5"} />
          )}
          {status === "needs_input" && <NotificationDot />}
        </span>
      }
      title={title || "Claude"}
      onRename={(newName) => props.api.setTitle(newName)}
    />
  );
}
