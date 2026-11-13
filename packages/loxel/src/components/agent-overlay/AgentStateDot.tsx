import type { AgentState } from "@/api/agent-overlay-model";
import { cn } from "@/lib/utils";

const STATE_CLASS: Record<AgentState, string> = {
  working: "bg-sky-400 animate-pulse",
  "needs-input": "bg-amber-400",
  idle: "bg-emerald-400/80",
  failed: "bg-red-500",
  ended: "bg-muted-foreground/50",
};

const STATE_TITLE: Record<AgentState, string> = {
  working: "Claude is working",
  "needs-input": "Claude needs your input",
  idle: "Claude is idle",
  failed: "Claude stopped with an error",
  ended: "The Claude session ended",
};

/** A coding agent's state as a dot, for tabs and the overlay header. */
export function AgentStateDot({ state, className }: { state: AgentState; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", STATE_CLASS[state], className)}
      title={STATE_TITLE[state]}
    />
  );
}
