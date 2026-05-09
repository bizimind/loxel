import { ChevronRightIcon, CopyIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import type { RawEvent } from "@/store/agent-devtools";

import { cn } from "@/lib/utils";

/** Color mapping for event type categories. */
function badgeColor(type: string): string {
  if (type.startsWith("session.")) return "bg-blue-500/20 text-blue-400";
  if (type === "run.started") return "bg-green-500/20 text-green-400";
  if (type === "run.completed") return "bg-green-500/20 text-green-400";
  if (type === "run.failed" || type === "run.cancelled") return "bg-red-500/20 text-red-400";
  if (type.startsWith("run.step.")) return "bg-cyan-500/20 text-cyan-400";
  if (type === "run.delta" || type === "run.reasoning") return "bg-zinc-500/20 text-zinc-500";
  if (type.startsWith("tool.call.") || type.startsWith("run.step.tool."))
    return "bg-purple-500/20 text-purple-400";
  if (type.startsWith("human.input.") || type.startsWith("approval."))
    return "bg-amber-500/20 text-amber-400";
  if (type.startsWith("plan.")) return "bg-indigo-500/20 text-indigo-400";
  if (type.startsWith("context.compaction.")) return "bg-orange-500/20 text-orange-400";
  if (type.startsWith("run.loop_control.") || type.startsWith("run.completion_conditions."))
    return "bg-pink-500/20 text-pink-400";
  if (type === "debug.snapshot") return "bg-slate-500/20 text-slate-400";
  if (type.startsWith("runtime.")) return "bg-red-500/20 text-red-400";
  return "bg-zinc-500/20 text-zinc-400";
}

/** Format ms offset as "+X.Xs" relative to a base timestamp. */
function formatRelativeTime(receivedAt: number, baseTime: number): string {
  const delta = (receivedAt - baseTime) / 1000;
  if (delta < 0.01) return "+0.0s";
  if (delta < 100) return `+${delta.toFixed(1)}s`;
  return `+${Math.round(delta)}s`;
}

/** One-line preview of event payload, truncated. */
function payloadPreview(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return json.length > 120 ? json.slice(0, 120) + "..." : json;
}

export const DevToolsEventRow = memo(function DevToolsEventRow({
  rawEvent,
  baseTime,
}: {
  rawEvent: RawEvent;
  baseTime: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(rawEvent.event, null, 2));
  }, [rawEvent.event]);

  const { event, receivedAt } = rawEvent;

  return (
    <div className="hover:bg-muted/30 group border-b border-b-transparent last:border-b-0">
      <button
        className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left font-mono text-xs leading-5"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon
          className={cn("text-muted-foreground size-3 shrink-0 transition-transform", {
            "rotate-90": expanded,
          })}
        />
        <span className="text-muted-foreground w-14 shrink-0 tabular-nums">
          {formatRelativeTime(receivedAt, baseTime)}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-px text-[10px] leading-4 font-semibold",
            badgeColor(event.type),
          )}
        >
          {event.type}
        </span>
        <span className="text-muted-foreground truncate">{payloadPreview(event.payload)}</span>
        <button
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          title="Copy JSON"
        >
          <CopyIcon className="text-muted-foreground hover:text-foreground size-3" />
        </button>
      </button>

      {expanded && (
        <pre className="bg-muted/50 text-foreground mx-2 mb-1 max-h-80 overflow-auto rounded p-2 text-[11px] leading-4">
          {JSON.stringify(rawEvent.event, null, 2)}
        </pre>
      )}
    </div>
  );
});
