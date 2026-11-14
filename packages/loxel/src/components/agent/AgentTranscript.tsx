/**
 * The conversation: assistant prose without boxes, the user's messages as a tinted bubble, and
 * tool activity as muted lines on a thin rail, grouped and expanded on click. What waits on the
 * user (questions, permissions, plans) is drawn by the caller at the place the agent asked,
 * through `renderRequest`.
 */
import {
  AlertCircleIcon,
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import type { AgentRequest, TranscriptItem } from "@/api/agent-session-model";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { isRecord } from "@/lib/is-record";
import { dispatchOpenFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/projects";

import {
  type ActivityItem,
  activityRunning,
  activitySummary,
  editDiffLines,
  type ToolKind,
  toolKind,
  transcriptBlocks,
} from "./agent-activity";
import { displayPath, toolSummary } from "./agent-tool-summary";
import { AgentMarkdown } from "./AgentMarkdown";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** What tool paths are shortened against: the panel's worktree, else the home directory. */
export function useToolPaths(): { root: string | null; home: string | null } {
  const root = usePanelWorktreePath();
  const home = useProjectStore((s) => s.homeDir);
  return useMemo(() => ({ root, home }), [root, home]);
}

const KIND_ICONS: Record<ToolKind, typeof WrenchIcon> = {
  read: FileTextIcon,
  edit: PencilIcon,
  run: SquareTerminalIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: BotIcon,
  ask: MessageCircleQuestionIcon,
  other: WrenchIcon,
};

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

function stringField(input: unknown, field: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[field];
  return typeof value === "string" ? value : null;
}

function toolFilePath(input: unknown): string | null {
  const path = stringField(input, "file_path") ?? stringField(input, "notebook_path");
  return path?.startsWith("/") ? path : null;
}

const preClass =
  "bg-foreground/[0.04] text-foreground/90 max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap";

export function DiffBlock({ lines }: { lines: { sign: "-" | "+"; text: string }[] }) {
  const shown = lines.slice(0, 80);
  return (
    <div className="max-h-80 overflow-auto rounded-md font-mono text-[12px] leading-[1.55]">
      {shown.map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre-wrap",
            line.sign === "+"
              ? "bg-diff-add-bg text-diff-add-text"
              : "bg-diff-del-bg text-diff-del-text",
          )}
        >
          <span className="mr-2 opacity-60 select-none">{line.sign}</span>
          {line.text || " "}
        </div>
      ))}
      {lines.length > shown.length && (
        <div className="text-muted-foreground px-3 py-1 text-[11px]">
          {lines.length - shown.length} more lines
        </div>
      )}
    </div>
  );
}

/** An edit's diff, or a write's whole content as added lines. */
export function editPreview(input: unknown): { sign: "-" | "+"; text: string }[] | null {
  const content = stringField(input, "content");
  return (
    editDiffLines(input) ??
    content?.split("\n").map((text) => ({ sign: "+" as const, text })) ??
    null
  );
}

function ToolDetail({ item }: { item: ToolItem }) {
  const [showOutput, setShowOutput] = useState(false);
  const kind = toolKind(item.name);
  const output = item.result?.text ?? "";
  const outputLines = output ? output.split("\n").length : 0;
  const command = stringField(item.input, "command");

  let body: React.ReactNode = null;
  if (kind === "run" && command !== null) {
    body = (
      <pre className={preClass}>
        <span className="text-muted-foreground select-none">$ </span>
        {command}
      </pre>
    );
  } else if (kind === "edit") {
    const diff = editPreview(item.input);
    body = diff ? <DiffBlock lines={diff} /> : null;
  } else if (kind !== "read") {
    body = <pre className={preClass}>{JSON.stringify(item.input, null, 2)}</pre>;
  }

  // Reads and edits say what happened in the row itself; their output is the file.
  const showsOutput =
    item.result &&
    !item.result.isError &&
    (kind === "run" || kind === "other" || kind === "search");
  return (
    <div className="mt-1.5 mb-2 space-y-1.5">
      {body}
      {item.result?.isError && <pre className={cn(preClass, "text-destructive")}>{output}</pre>}
      {showsOutput && (
        <>
          <button
            type="button"
            onClick={() => setShowOutput((v) => !v)}
            className="text-muted-foreground hover:text-foreground text-[12px]"
          >
            {showOutput
              ? "Hide output"
              : `Show output (${outputLines} line${outputLines === 1 ? "" : "s"})`}
          </button>
          {showOutput && <pre className={preClass}>{output || "(no output)"}</pre>}
        </>
      )}
    </div>
  );
}

function ToolEntry({ item, groups }: { item: ToolItem; groups: ItemsByParent }) {
  const [open, setOpen] = useState(false);
  const paths = useToolPaths();
  const Icon = KIND_ICONS[toolKind(item.name)];
  const filePath = toolFilePath(item.input);
  const nested = groups.get(item.id) ?? [];
  const toggle = () => setOpen((v) => !v);

  return (
    <li>
      <div className="flex min-w-0 items-center gap-2 py-[3px] text-[13px]">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-2"
        >
          <Icon className="size-3.5" />
          <span className="text-foreground/80">{item.name}</span>
        </button>
        {filePath ? (
          <button
            type="button"
            onClick={() => dispatchOpenFile(filePath)}
            title={`Open ${filePath}`}
            className="text-muted-foreground hover:text-link truncate font-mono text-[12px] hover:underline"
          >
            {displayPath(filePath, paths.root, paths.home)}
          </button>
        ) : (
          <button
            type="button"
            onClick={toggle}
            className="text-muted-foreground truncate text-left font-mono text-[12px]"
          >
            {toolSummary(item.name, item.input, paths)}
          </button>
        )}
        {item.result === null && <LoaderIcon className="text-ring size-3 shrink-0 animate-spin" />}
        {item.result?.isError && <XIcon className="text-destructive size-3 shrink-0" />}
      </div>
      {nested.length > 0 && (
        <div className="border-border mb-1 ml-1.5 border-l pl-3">
          <TranscriptBlocks items={nested} groups={groups} compact renderRequest={noRequest} />
        </div>
      )}
      {open && <ToolDetail item={item} />}
    </li>
  );
}

function ThinkingEntry({ item }: { item: Extract<TranscriptItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex items-center gap-2 py-[3px] text-[13px]"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span className={cn(item.streaming && "animate-pulse")}>
          {item.streaming ? "Thinking…" : "Thought"}
        </span>
      </button>
      {open && (
        <div className="text-muted-foreground mt-0.5 mb-2 text-[13px] leading-relaxed whitespace-pre-wrap italic">
          {item.text}
        </div>
      )}
    </li>
  );
}

/** A run of tool calls and thinking: one summary line, the entries under it on a rail. */
function ActivityGroup({
  items,
  groups,
  defaultOpen,
}: {
  items: ActivityItem[];
  groups: ItemsByParent;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const running = activityRunning(items);
  // Collapsed, a running group still shows what it is doing now.
  const current = running ? items.findLast((item) => item.kind === "tool" && !item.result) : null;
  const visible = open ? items : current ? [current] : [];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[13px]"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {activitySummary(items)}
      </button>
      {visible.length > 0 && (
        <ul className="border-border mt-1 ml-[6px] border-l pl-4">
          {visible.map((item) =>
            item.kind === "tool" ? (
              <ToolEntry key={item.id} item={item} groups={groups} />
            ) : (
              <ThinkingEntry key={item.id} item={item} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/** The answers in the result text AskUserQuestion returns (`"question"="answer"`). */
function answeredSummary(result: string): string {
  const answers = [...result.matchAll(/"[^"]*"="([^"]*)"/g)].map((m) => m[1]);
  return answers.length > 0 ? answers.join(", ") : result;
}

/** A question or plan already answered: one quiet line; the plan opens as a document. */
function InteractionRecord({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  if (item.name === "ExitPlanMode") {
    const approved = item.result && !item.result.isError;
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[13px]"
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          <ClipboardListIcon className="size-3.5" />
          {approved ? "Plan approved" : item.result ? "Kept planning" : "Plan proposed"}
        </button>
        {open && (
          <div className="border-border mt-2 ml-[6px] border-l pl-4">
            <AgentMarkdown text={stringField(item.input, "plan") ?? ""} compact />
          </div>
        )}
      </div>
    );
  }
  const questions =
    isRecord(item.input) && Array.isArray(item.input.questions) ? item.input.questions : [];
  const question = stringField(questions[0], "question") ?? "Claude asked";
  return (
    <div className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-[13px]">
      <MessageCircleQuestionIcon className="size-3.5 shrink-0 translate-y-0.5" />
      <span className="truncate">{question}</span>
      {item.result && (
        <span className="text-foreground/80 shrink-0">→ {answeredSummary(item.result.text)}</span>
      )}
    </div>
  );
}

function UserMessage({ item }: { item: Extract<TranscriptItem, { kind: "user" }> }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "bg-foreground/[0.06] text-foreground max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap",
          item.queued && "opacity-60",
        )}
      >
        {item.text}
        {item.imageCount > 0 && (
          <span className="text-muted-foreground ml-1 text-xs">
            +{item.imageCount} image{item.imageCount > 1 ? "s" : ""}
          </span>
        )}
        {item.queued && <span className="text-muted-foreground ml-2 text-[11px]">queued</span>}
      </div>
    </div>
  );
}

function Notice({ item }: { item: Extract<TranscriptItem, { kind: "notice" }> }) {
  const Icon = item.level === "error" ? AlertCircleIcon : InfoIcon;
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 text-[13px]",
        item.level === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{item.text}</span>
    </div>
  );
}

type RenderRequest = (toolUseId: string) => React.ReactNode;

const noRequest: RenderRequest = () => null;

const TranscriptBlocks = memo(function TranscriptBlocks({
  items,
  groups,
  compact,
  renderRequest,
}: {
  items: readonly TranscriptItem[];
  groups: ItemsByParent;
  compact: boolean;
  renderRequest: RenderRequest;
}) {
  const blocks = useMemo(() => transcriptBlocks(items), [items]);
  return (
    <div className={compact ? "space-y-2" : "space-y-5"}>
      {blocks.map((block, index) => {
        if (block.kind === "item") {
          const { item } = block;
          switch (item.kind) {
            case "user":
              return <UserMessage key={item.id} item={item} />;
            case "text":
              return <AgentMarkdown key={item.id} text={item.text} compact={compact} />;
            case "notice":
              return <Notice key={item.id} item={item} />;
            default: {
              const _unknown: never = item;
              return null;
            }
          }
        }
        // Questions and plans leave the rail: a pending one becomes its card here, an answered
        // one a quiet line.
        const asks = block.items.filter(
          (i): i is ToolItem => i.kind === "tool" && toolKind(i.name) === "ask",
        );
        const work = block.items.filter((i) => i.kind !== "tool" || toolKind(i.name) !== "ask");
        const tools = block.items.filter((i): i is ToolItem => i.kind === "tool");
        return (
          <div key={block.id} className="space-y-3">
            {work.length > 0 && (
              <ActivityGroup
                items={work}
                groups={groups}
                defaultOpen={compact || index === blocks.length - 1}
              />
            )}
            {tools.map((tool) => {
              const card = renderRequest(tool.id);
              if (card) return <div key={tool.id}>{card}</div>;
              return asks.includes(tool) ? <InteractionRecord key={tool.id} item={tool} /> : null;
            })}
          </div>
        );
      })}
    </div>
  );
});

export function AgentTranscript({
  items,
  pending,
  renderRequest,
}: {
  items: readonly TranscriptItem[];
  pending: readonly AgentRequest[];
  renderRequest: (request: AgentRequest) => React.ReactNode;
}) {
  const groups = useMemo(() => groupByParent(items), [items]);
  const byTool = useMemo(() => new Map(pending.map((r) => [r.toolUseId, r])), [pending]);
  const render = useMemo<RenderRequest>(
    () => (toolUseId) => {
      const request = byTool.get(toolUseId);
      return request ? renderRequest(request) : null;
    },
    [byTool, renderRequest],
  );
  // A request whose call is not on the main thread's timeline (not shown yet, or a subagent's)
  // goes after it.
  const mainTools = useMemo(
    () =>
      new Set((groups.get(null) ?? []).flatMap((item) => (item.kind === "tool" ? [item.id] : []))),
    [groups],
  );
  const unanchored = pending.filter((r) => !mainTools.has(r.toolUseId));

  return (
    <div className="space-y-5">
      <TranscriptBlocks
        items={groups.get(null) ?? []}
        groups={groups}
        compact={false}
        renderRequest={render}
      />
      {unanchored.map((request) => (
        <div key={request.requestId}>{renderRequest(request)}</div>
      ))}
    </div>
  );
}
