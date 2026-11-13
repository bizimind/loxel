import {
  AlertCircleIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  InfoIcon,
  LoaderIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import type { TranscriptItem } from "@/api/agent-session-model";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/projects";

import { isSubagentTool, toolSummary } from "./agent-tool-summary";
import { AgentMarkdown } from "./AgentMarkdown";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** What tool paths are shortened against: the panel's worktree, else the home directory. */
export function useToolPaths(): { root: string | null; home: string | null } {
  const root = usePanelWorktreePath();
  const home = useProjectStore((s) => s.homeDir);
  return useMemo(() => ({ root, home }), [root, home]);
}

/** Items by the tool call whose subagent produced them; the main thread's under null. */
type ItemsByParent = ReadonlyMap<string | null, readonly TranscriptItem[]>;

function groupByParent(items: readonly TranscriptItem[]): ItemsByParent {
  const groups = new Map<string | null, TranscriptItem[]>();
  for (const item of items) {
    const parent = "parentToolUseId" in item ? item.parentToolUseId : null;
    const list = groups.get(parent) ?? [];
    list.push(item);
    groups.set(parent, list);
  }
  return groups;
}

function Disclosure({
  open,
  onToggle,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "text-muted-foreground hover:text-foreground flex w-full min-w-0 items-center gap-1.5 text-left text-xs",
        className,
      )}
    >
      <ChevronRightIcon
        className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
      />
      {children}
    </button>
  );
}

function ToolRow({ item, groups }: { item: ToolItem; groups: ItemsByParent }) {
  const [open, setOpen] = useState(false);
  const paths = useToolPaths();
  const summary = toolSummary(item.name, item.input, paths);
  const subagent = isSubagentTool(item.name);
  const status = item.result ? (item.result.isError ? "error" : "done") : "running";
  const nested = groups.get(item.id) ?? [];

  return (
    <div className="border-border/60 rounded-md border px-3 py-1.5">
      <Disclosure open={open} onToggle={() => setOpen((v) => !v)}>
        <WrenchIcon className="size-3 shrink-0" />
        <span className="text-foreground shrink-0 font-medium">{item.name}</span>
        <span className="truncate font-mono text-[11px]">{summary}</span>
        <span className="ml-auto shrink-0 pl-2">
          {status === "running" && <LoaderIcon className="size-3 animate-spin" />}
          {status === "done" && <CheckIcon className="size-3 text-green-500" />}
          {status === "error" && <XIcon className="text-destructive size-3" />}
        </span>
      </Disclosure>
      {subagent && nested.length > 0 && (
        <div className="border-border/60 mt-2 ml-1.5 space-y-2 border-l pl-3">
          <TranscriptList parent={item.id} groups={groups} compact />
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <pre className="bg-muted/50 max-h-64 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {item.result && (
            <pre
              className={cn(
                "bg-muted/50 max-h-80 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap",
                item.result.isError && "text-destructive",
              )}
            >
              {item.result.text || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ item }: { item: Extract<TranscriptItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Disclosure open={open} onToggle={() => setOpen((v) => !v)}>
        <BrainIcon className="size-3 shrink-0" />
        <span>{item.streaming ? "Thinking…" : "Thought"}</span>
      </Disclosure>
      {open && (
        <div className="text-muted-foreground mt-1.5 ml-4.5 text-[13px] leading-relaxed whitespace-pre-wrap italic">
          {item.text}
        </div>
      )}
    </div>
  );
}

const Item = memo(function Item({
  item,
  groups,
  compact,
}: {
  item: TranscriptItem;
  groups: ItemsByParent;
  compact: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="bg-muted text-foreground max-w-[85%] rounded-lg px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap">
            {item.text}
            {item.imageCount > 0 && (
              <span className="text-muted-foreground ml-1 text-xs">
                (+{item.imageCount} image{item.imageCount > 1 ? "s" : ""})
              </span>
            )}
            {item.queued && (
              <span className="text-muted-foreground mt-1 flex items-center gap-1 text-[11px]">
                <ClockIcon className="size-3" /> Queued
              </span>
            )}
          </div>
        </div>
      );
    case "text":
      return (
        <div className={cn(compact && "text-[13px]")}>
          <AgentMarkdown text={item.text} />
        </div>
      );
    case "thinking":
      return <ThinkingRow item={item} />;
    case "tool":
      return <ToolRow item={item} groups={groups} />;
    case "notice":
      return (
        <div
          className={cn(
            "flex items-start gap-1.5 text-xs",
            item.level === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {item.level === "error" ? (
            <AlertCircleIcon className="mt-0.5 size-3 shrink-0" />
          ) : (
            <InfoIcon className="mt-0.5 size-3 shrink-0" />
          )}
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      );
    default: {
      const _unknown: never = item;
      return null;
    }
  }
});

function TranscriptList({
  parent,
  groups,
  compact,
}: {
  parent: string | null;
  groups: ItemsByParent;
  compact: boolean;
}) {
  return (
    <>
      {(groups.get(parent) ?? []).map((item) => (
        <Item key={item.id} item={item} groups={groups} compact={compact} />
      ))}
    </>
  );
}

export function AgentTranscript({ items }: { items: readonly TranscriptItem[] }) {
  const groups = useMemo(() => groupByParent(items), [items]);
  return (
    <div className="space-y-4">
      <TranscriptList parent={null} groups={groups} compact={false} />
    </div>
  );
}
