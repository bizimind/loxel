import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  PencilIcon,
  SearchIcon,
  SquareSlashIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { memo, useState } from "react";

import type { AgentJson, AgentTranscriptItem } from "@/api/agent-overlay-model";
import { openPath } from "@/lib/open-path";
import { cn } from "@/lib/utils";

import { AgentMarkdown, CodeBlock } from "./AgentMarkdown";

type ToolItem = Extract<AgentTranscriptItem, { kind: "tool" }>;

function field(input: AgentJson, name: string): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = (input as Record<string, AgentJson>)[name];
  return typeof value === "string" ? value : null;
}

/** A path as the row shows it: relative to the session's directory, else `~/…` under home. */
function shownPath(path: string, cwd: string, home: string): string {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

interface ToolLook {
  icon: LucideIcon;
  /** What the row says after the tool's name. */
  summary: string | null;
  /** A file the row opens in the editor. */
  file: string | null;
}

function toolLook(item: ToolItem, cwd: string, home: string): ToolLook {
  const { name, input } = item;
  const path = field(input, "file_path") ?? field(input, "notebook_path");
  switch (name) {
    case "Bash":
      return { icon: TerminalIcon, summary: field(input, "command"), file: null };
    case "Read":
      return { icon: FileTextIcon, summary: path && shownPath(path, cwd, home), file: path };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { icon: PencilIcon, summary: path && shownPath(path, cwd, home), file: path };
    case "Grep":
    case "Glob":
      return { icon: SearchIcon, summary: field(input, "pattern"), file: null };
    case "WebFetch":
    case "WebSearch":
      return { icon: GlobeIcon, summary: field(input, "url") ?? field(input, "query"), file: null };
    case "Agent":
    case "Task":
      return {
        icon: BotIcon,
        summary: [field(input, "subagent_type"), field(input, "description")]
          .filter(Boolean)
          .join(" · "),
        file: null,
      };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { icon: ListTodoIcon, summary: null, file: null };
    case "AskUserQuestion":
      return { icon: MessageCircleQuestionIcon, summary: null, file: null };
    default:
      return { icon: WrenchIcon, summary: null, file: null };
  }
}

const RESULT_LINES = 40;

function ToolRow({ item, cwd, home }: { item: ToolItem; cwd: string; home: string }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const look = toolLook(item, cwd, home);
  const Icon = look.icon;
  const status = item.result === null ? "running" : item.result.isError ? "error" : "done";
  const resultLines = item.result?.text.split("\n") ?? [];
  const shown = full ? resultLines : resultLines.slice(0, RESULT_LINES);
  const plan = item.name === "ExitPlanMode" ? field(item.input, "plan") : null;

  return (
    <div className="group/tool text-[13px]">
      <button
        type="button"
        className="hover:bg-muted/50 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left"
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon
          className={cn(
            "text-muted-foreground size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground shrink-0 font-medium">{item.name}</span>
        {look.summary && (
          <span
            className={cn(
              "text-muted-foreground min-w-0 truncate font-mono text-xs",
              look.file && "hover:text-foreground cursor-pointer hover:underline",
            )}
            onClick={(event) => {
              if (!look.file) return;
              event.stopPropagation();
              void openPath(look.file);
            }}
          >
            {look.summary}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {status === "running" && (
            <Loader2Icon className="text-muted-foreground size-3.5 animate-spin" />
          )}
          {status === "done" && <CheckIcon className="size-3.5 text-green-500/80" />}
          {status === "error" && <XIcon className="size-3.5 text-red-500/80" />}
        </span>
      </button>
      {plan && !open && (
        <div className="border-border mt-1 ml-7 rounded-md border px-4 py-3">
          <AgentMarkdown text={plan} />
        </div>
      )}
      {open && (
        <div className="mt-1 ml-7 space-y-2">
          <CodeBlock code={JSON.stringify(item.input, null, 2)} language="json" />
          {item.result && (
            <div
              className={cn(
                "bg-surface-1 overflow-x-auto rounded-md px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre",
                item.result.isError ? "text-red-400" : "text-muted-foreground",
              )}
            >
              {shown.join("\n") || "(no output)"}
              {!full && resultLines.length > RESULT_LINES && (
                <button
                  type="button"
                  className="text-foreground mt-2 block underline"
                  onClick={() => setFull(true)}
                >
                  Show all {resultLines.length} lines
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13px]">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex items-center gap-2 px-2 py-1"
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        <BrainIcon className="size-3.5" />
        Thinking
      </button>
      {open && (
        <div className="text-muted-foreground ml-7 border-l pl-4 italic opacity-80">
          <AgentMarkdown text={text} />
        </div>
      )}
    </div>
  );
}

const TranscriptItem = memo(function TranscriptItem({
  item,
  cwd,
  home,
}: {
  item: AgentTranscriptItem;
  cwd: string;
  home: string;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="bg-muted/40 border-border/60 rounded-lg border px-4 py-3">
          <div className="text-foreground text-[15px] leading-relaxed whitespace-pre-wrap">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="px-1">
          <AgentMarkdown text={item.text} />
        </div>
      );
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return <ToolRow item={item} cwd={cwd} home={home} />;
    case "command":
      return (
        <div className="text-[13px]">
          <div className="flex items-center gap-2 px-2 py-1">
            <SquareSlashIcon className="text-muted-foreground size-3.5" />
            <span className="text-foreground font-mono">{item.name}</span>
            {item.args && <span className="text-muted-foreground font-mono">{item.args}</span>}
          </div>
          {item.output && (
            <div className="bg-surface-1 text-muted-foreground mt-1 ml-7 overflow-x-auto rounded-md px-4 py-3 font-mono text-xs whitespace-pre">
              {item.output}
            </div>
          )}
        </div>
      );
    case "system":
      return (
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <div className="bg-border h-px flex-1" />
          {item.text}
          <div className="bg-border h-px flex-1" />
        </div>
      );
    default: {
      const unknown: never = item;
      return unknown;
    }
  }
});

/** The conversation, from the transcript Claude writes. */
export function AgentTranscript({
  items,
  cwd,
  home,
}: {
  items: AgentTranscriptItem[];
  cwd: string;
  home: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => (
        <TranscriptItem key={item.id} item={item} cwd={cwd} home={home} />
      ))}
    </div>
  );
}
