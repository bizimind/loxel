import type { IDockviewPanelHeaderProps } from "dockview-react";
import { BotIcon } from "lucide-react";

import { STATUS_DOT_CLASS, STATUS_LABELS } from "@/components/agent/agent-status";
import { useAgentStatusStore } from "@/components/agent/use-agent-session";
import type { AgentPanelParams } from "@/lib/panel-creators";
import { cn } from "@/lib/utils";

import { Tab, usePanelTitle } from "./tab";

/** An agent panel's tab: its title and a dot for the agent's state (working, needs input, …). */
export function AgentTab(props: IDockviewPanelHeaderProps<AgentPanelParams>) {
  const status = useAgentStatusStore((s) => s.statuses[props.params.agentId]);
  const title = usePanelTitle(props.api);
  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative shrink-0" title={status ? STATUS_LABELS[status] : undefined}>
          <BotIcon className="size-3.5" />
          {status && status !== "idle" && status !== "starting" && (
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
                STATUS_DOT_CLASS[status],
              )}
            />
          )}
        </span>
      }
      title={title || "Agent"}
      onRename={(name) => props.api.setTitle(name)}
    />
  );
}
