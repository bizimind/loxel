import type { IDockviewPanelHeaderProps } from "dockview-react";
import { BotIcon, BugPlayIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCodingAgentStore } from "@/store/coding-agent";

import { Tab } from "./tab";

export function CodingAgentTab(props: IDockviewPanelHeaderProps<{ sessionId: string }>) {
  const sessionId = props.params.sessionId;
  const status = useCodingAgentStore((s) => s.sessions[sessionId]?.status ?? "starting");

  const dotColor =
    status === "running"
      ? "bg-green-500"
      : status === "waiting"
        ? "bg-amber-500"
        : status === "exited"
          ? "bg-gray-500"
          : "bg-blue-500";

  return (
    <Tab
      api={props.api}
      icon={<BotIcon className="size-3.5 shrink-0" />}
      title={props.api.title ?? "Agent"}
      leading={<span className={cn("inline-block size-2 shrink-0 rounded-full", dotColor)} />}
      trailing={
        <button
          className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
          title="Open DevTools"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent("loxel-open-agent-devtools", { detail: { sessionId } }),
            );
          }}
        >
          <BugPlayIcon className="size-3" />
        </button>
      }
    />
  );
}
