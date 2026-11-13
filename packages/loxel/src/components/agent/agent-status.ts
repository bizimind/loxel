import type { AgentStatus } from "@/api/agent-session-model";

/** How each agent state is named and colored, in the panel header and on the tab. */
export const STATUS_LABELS: Record<AgentStatus, string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  needs_input: "Needs input",
  failed: "Stopped",
  handed_off: "In terminal",
};

export const STATUS_DOT_CLASS: Record<AgentStatus, string> = {
  starting: "bg-muted-foreground",
  idle: "bg-green-500",
  working: "bg-sky-500 animate-pulse",
  needs_input: "bg-amber-500",
  failed: "bg-destructive",
  handed_off: "bg-violet-500",
};
