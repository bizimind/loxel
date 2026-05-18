import type { IDockviewPanelHeaderProps } from "dockview-react";
import { BugPlayIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCodingAgentStore } from "@/store/coding-agent";

import { Tab } from "./tab";

export function AgentDevToolsTab(props: IDockviewPanelHeaderProps<{ sessionId: string }>) {
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
      icon={<BugPlayIcon className="size-3.5 shrink-0" />}
      title={props.api.title ?? "DevTools"}
      leading={<span className={cn("inline-block size-2 shrink-0 rounded-full", dotColor)} />}
    />
  );
}
