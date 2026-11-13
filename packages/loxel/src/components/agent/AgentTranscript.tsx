/**
 * The agent's conversation: user messages, the agent's markdown replies, collapsible thinking and
 * tool calls, and each subagent's activity nested under the tool call that started it.
 */
import {
  AlertTriangleIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  FileTextIcon,
  ImageIcon,
  InfoIcon,
  LoaderCircleIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import type { TranscriptItem } from "@/api/agent-session-model";
import { cn } from "@/lib/utils";

import { AgentMarkdown } from "./AgentMarkdown";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** A string field of a tool call's input. */
export function inputField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** A one-line summary of a tool call, like the TUI's `Bash(npm test)`. */
export function toolSummary(name: string, input: unknown): string {
  const field = (key: string) => inputField(input, key);
  switch (name) {
    case "Bash":
      return field("description") ?? field("command") ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return field("file_path") ?? field("notebook_path") ?? "";
    case "Grep":
      return [field("pattern"), field("path")].filter(Boolean).join(" in ");
    case "Glob":
      return field("pattern") ?? "";
    case "WebFetch":
      return field("url") ?? "";
    case "WebSearch":
      return field("query") ?? "";
    case "Agent":
    case "Task":
      return field("description") ?? field("subagent_type") ?? "";
    case "Skill":
      return field("skill") ?? field("command") ?? "";
    default:
      return field("description") ?? "";
  }
}

function toolIcon(name: string) {
  switch (name) {
    case "Bash":
      return SquareTerminalIcon;
    case "Read":
      return FileTextIcon;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return PencilIcon;
    case "Grep":
    case "Glob":
    case "WebSearch":
      return SearchIcon;
    case "Agent":
    case "Task":
      return BotIcon;
    default:
      return WrenchIcon;
  }
}

const RESULT_PREVIEW_CHARS = 20_000;

function ToolInput({ item }: { item: ToolItem }) {
  const command = item.name === "Bash" ? inputField(item.input, "command") : undefined;
  if (command) return <pre className="agent-tool-pre">{command}</pre>;
  const oldText = inputField(item.input, "old_string");
  const newText = inputField(item.input, "new_string");
  if (oldText !== undefined && newText !== undefined) {
    return (
      <div className="flex flex-col gap-1">
        <pre className="agent-tool-pre agent-tool-pre-del">{oldText}</pre>
        <pre className="agent-tool-pre agent-tool-pre-add">{newText}</pre>
      </div>
    );
  }
  return <pre className="agent-tool-pre">{JSON.stringify(item.input, null, 2)}</pre>;
}

function Disclosure({
  header,
  children,
  defaultOpen = false,
  className,
}: {
  header: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        className="hover:bg-muted/60 text-muted-foreground flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        {header}
      </button>
      {open && <div className="mt-1 ml-5">{children}</div>}
    </div>
  );
}

const ToolRow = memo(function ToolRow({
  item,
  childrenOf,
}: {
  item: ToolItem;
  childrenOf: (parentId: string) => TranscriptItem[];
}) {
  const Icon = toolIcon(item.name);
  const nested = childrenOf(item.id);
  const summary = toolSummary(item.name, item.input);
  const state = !item.result ? "running" : item.result.isError ? "error" : "done";
  return (
    <Disclosure
      className="my-0.5"
      header={
        <>
          <Icon className="size-3.5 shrink-0" />
          <span className="text-foreground shrink-0 font-medium">{item.name}</span>
          <span className="min-w-0 truncate font-mono text-[11px]">{summary}</span>
          {nested.length > 0 && (
            <span className="shrink-0 text-[11px]">· {nested.length} steps</span>
          )}
          <span className="ml-auto shrink-0">
            {state === "running" && <LoaderCircleIcon className="size-3 animate-spin" />}
            {state === "done" && <CheckIcon className="size-3 text-green-500" />}
            {state === "error" && <XIcon className="text-destructive size-3" />}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-2 pb-2">
        <ToolInput item={item} />
        {nested.length > 0 && (
          <div className="border-border border-l pl-3">
            <TranscriptItems items={nested} childrenOf={childrenOf} />
          </div>
        )}
        {item.result && (
          <pre className={cn("agent-tool-pre", item.result.isError && "text-destructive")}>
            {item.result.text.length > RESULT_PREVIEW_CHARS
              ? `${item.result.text.slice(0, RESULT_PREVIEW_CHARS)}\n… (${item.result.text.length - RESULT_PREVIEW_CHARS} more characters)`
              : item.result.text || "(no output)"}
          </pre>
        )}
      </div>
    </Disclosure>
  );
});

function TranscriptEntry({
  item,
  childrenOf,
}: {
  item: TranscriptItem;
  childrenOf: (parentId: string) => TranscriptItem[];
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="my-4 flex justify-end">
          <div className="bg-muted text-foreground max-w-[85%] rounded-lg px-3.5 py-2 text-[length:var(--loxel-font-prose-size)] leading-relaxed whitespace-pre-wrap">
            {item.text}
            {item.imageCount > 0 && (
              <span className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                <ImageIcon className="size-3" />
                {item.imageCount} image{item.imageCount > 1 ? "s" : ""}
              </span>
            )}
            {item.queued && (
              <span className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                <ClockIcon className="size-3" />
                Queued
              </span>
            )}
          </div>
        </div>
      );
    case "assistant":
      return <AgentMarkdown text={item.text} className="my-3" />;
    case "thinking":
      return (
        <Disclosure
          className="my-1"
          header={
            <>
              <BrainIcon className="size-3.5 shrink-0" />
              <span className="italic">{item.streaming ? "Thinking…" : "Thought"}</span>
            </>
          }
        >
          <div className="text-muted-foreground pb-2 text-xs leading-relaxed whitespace-pre-wrap italic">
            {item.text || "(hidden)"}
          </div>
        </Disclosure>
      );
    case "tool":
      return <ToolRow item={item} childrenOf={childrenOf} />;
    case "notice":
      return item.tone === "error" ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive my-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      ) : (
        <div className="text-muted-foreground my-3 flex items-start gap-2 text-xs">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <AgentMarkdown text={item.text} className="min-w-0 flex-1 text-xs" />
        </div>
      );
    default: {
      const unknown: never = item;
      return unknown;
    }
  }
}

function TranscriptItems({
  items,
  childrenOf,
}: {
  items: TranscriptItem[];
  childrenOf: (parentId: string) => TranscriptItem[];
}) {
  return items.map((item) => <TranscriptEntry key={item.id} item={item} childrenOf={childrenOf} />);
}

function parentOf(item: TranscriptItem): string | null {
  return item.kind === "assistant" || item.kind === "thinking" || item.kind === "tool"
    ? item.parentToolUseId
    : null;
}

export function AgentTranscript({ items }: { items: TranscriptItem[] }) {
  const { roots, childrenOf } = useMemo(() => {
    const toolIds = new Set(items.filter((i) => i.kind === "tool").map((i) => i.id));
    const byParent = new Map<string, TranscriptItem[]>();
    const top: TranscriptItem[] = [];
    for (const item of items) {
      const parent = parentOf(item);
      // Entries of a subagent whose tool call is not in the transcript stay at the top level.
      if (parent && toolIds.has(parent)) {
        const list = byParent.get(parent) ?? [];
        list.push(item);
        byParent.set(parent, list);
      } else {
        top.push(item);
      }
    }
    return { roots: top, childrenOf: (id: string) => byParent.get(id) ?? [] };
  }, [items]);

  return <TranscriptItems items={roots} childrenOf={childrenOf} />;
}
