import type { TodoItem } from "@bizimind/coding-agent/schemas";

/**
 * Coding agent timeline component.
 * Renders messages, tool calls, plans, and events in a scrollable container.
 * Adapted from ccm-web CodingAgentTimeline.
 */
import { AlertCircle, BrainCircuit, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  CodingAgentTimelineItem,
  PendingApproval,
  PendingHumanInput,
} from "@/api/coding-agent-model";
import type { AgentStatus } from "@/api/ws-protocol";

import { cn } from "@/lib/utils";

import { AgentMarkdown } from "./AgentMarkdown";
import { CodingAgentInteractionOverlay } from "./CodingAgentInteractionOverlay";
import { MessageActions } from "./GutterDot";
import { ToolUseCard } from "./ToolUseCard";

interface CodingAgentTimelineProps {
  items: CodingAgentTimelineItem[];
  todos: TodoItem[];
  isReplaying?: boolean;
  status?: AgentStatus;
  pendingHumanInput: PendingHumanInput | null;
  pendingApproval: PendingApproval | null;
  onSubmitHumanInput: (args: {
    runId: string;
    pendingKey: string;
    answers: Record<string, string[]>;
    freeform: Record<string, string>;
  }) => void;
  onSubmitApproval: (args: {
    runId: string;
    pendingKey: string;
    toolName: string;
    decision: string;
  }) => void;
  onRewind?: (timelineItemId: string) => void;
  onFork?: (timelineItemId: string) => void;
}

export function CodingAgentTimeline({
  items,
  todos,
  isReplaying,
  status,
  pendingHumanInput,
  pendingApproval,
  onSubmitHumanInput,
  onSubmitApproval,
  onRewind,
  onFork,
}: CodingAgentTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const actionsDisabled = status !== "ready" && status !== "waiting" && status !== "running";

  // Track if user is at bottom for auto-scroll
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      wasAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 40;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll on new items or pending interactions (unless replaying or user scrolled up)
  const hasPending = pendingHumanInput !== null || pendingApproval !== null;
  useEffect(() => {
    if (isReplaying) return;
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [items.length, isReplaying, hasPending]);

  return (
    <div ref={scrollRef} className="bg-editor-surface min-h-0 flex-1 overflow-y-auto">
      {items.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">
          {status === "ready"
            ? "Agent is ready. Send a message to start."
            : "Send a message to start."}
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-6 pb-24 pl-2">
          {items.map((item) => {
            const hasActions =
              item.kind === "user" ||
              item.kind === "assistant" ||
              item.kind === "tool-call" ||
              item.kind === "tool-result";

            return (
              <div
                key={item.id}
                className={cn(
                  "group/row flex items-start gap-2",
                  item.kind === "assistant" && "py-2",
                )}
              >
                {hasActions && (
                  <MessageActions
                    disabled={actionsDisabled}
                    onRewind={() => onRewind?.(item.id)}
                    onFork={() => onFork?.(item.id)}
                  />
                )}
                <div className={cn("min-w-0 flex-1", !hasActions && "pl-13")}>
                  <TimelineItemRenderer item={item} isRunning={status === "running"} />
                </div>
              </div>
            );
          })}
          {todos.length > 0 && <TodoList todos={todos} />}
          {status === "running" && <TypingIndicator />}
          <CodingAgentInteractionOverlay
            pendingHumanInput={pendingHumanInput}
            pendingApproval={pendingApproval}
            onSubmitHumanInput={onSubmitHumanInput}
            onSubmitApproval={onSubmitApproval}
          />
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function TimelineItemRenderer({
  item,
  isRunning,
}: {
  item: CodingAgentTimelineItem;
  isRunning: boolean;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessageItem body={item.body} />;
    case "reasoning":
      return <ReasoningItem body={item.body} />;
    case "assistant":
      return <AssistantMessageItem body={item.body} />;
    case "tool-call":
      return (
        <ToolItem
          toolName={item.toolName ?? "Tool"}
          toolInput={item.toolInput ?? {}}
          toolResult={item.toolResult}
          isRunning={isRunning}
        />
      );
    case "tool-result":
      return (
        <ToolItem
          toolName={item.toolName ?? "Tool"}
          toolInput={item.toolInput ?? {}}
          toolResult={item.toolResult}
          isRunning={isRunning}
        />
      );
    case "plan":
      return <PlanItem steps={item.planSteps} body={item.body} />;
    case "event":
      return <EventItem title={item.title} body={item.body} />;
    default:
      return null;
  }
}

function UserMessageItem({ body }: { body: string }) {
  return (
    <div>
      <div className="bg-card w-fit rounded-lg px-4 py-3 shadow-sm">
        <p className="text-muted-foreground text-sm break-words whitespace-pre-wrap">{body}</p>
      </div>
    </div>
  );
}

function AssistantMessageItem({ body }: { body: string }) {
  if (!body.trim()) return null;
  return <AgentMarkdown content={body} />;
}

function ReasoningItem({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);

  const firstLine = body.split("\n")[0] ?? "";
  const preview = firstLine.length > 50 ? firstLine.slice(0, 50) + "..." : firstLine;

  return (
    <div className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-muted-foreground/70 flex w-full items-center gap-1.5 py-0.5 text-left text-xs"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <BrainCircuit className="size-3 shrink-0 opacity-70" />
        <span className="font-medium">Thinking</span>
        {!expanded && <span className="min-w-0 flex-1 truncate italic opacity-70">{preview}</span>}
      </button>
      {expanded && (
        <div className="text-muted-foreground/70 mt-1 pl-[18px] text-xs">
          <p className="break-words whitespace-pre-wrap italic">{body}</p>
        </div>
      )}
    </div>
  );
}

function ToolItem({
  toolName,
  toolInput,
  toolResult,
  isRunning,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: { content: string; is_error?: boolean };
  isRunning: boolean;
}) {
  return (
    <div className="space-y-1">
      <ToolUseCard name={toolName} input={toolInput} result={toolResult} isRunning={isRunning} />
    </div>
  );
}

function PlanItem({ steps, body }: { steps?: CodingAgentTimelineItem["planSteps"]; body: string }) {
  const [expanded, setExpanded] = useState(true);

  const hasSteps = steps && steps.length > 0;
  const completedCount = hasSteps ? steps.filter((s) => s.status === "completed").length : 0;
  const totalCount = hasSteps ? steps.length : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-blue-500/20 bg-blue-500/5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-4 shrink-0" />
        )}
        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">Plan</span>
        {hasSteps && (
          <span className="text-muted-foreground text-xs">
            {completedCount}/{totalCount}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-blue-500/20 px-3 py-2">
          {hasSteps ? (
            <ul className="space-y-1">
              {steps.map((step) => (
                <li key={step.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-px shrink-0">{planStatusIcon(step.status)}</span>
                  <span
                    className={cn(
                      "text-muted-foreground",
                      step.status === "completed" && "line-through opacity-60",
                      step.status === "blocked" && "text-red-400 opacity-70",
                    )}
                  >
                    {step.title}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <pre className="text-muted-foreground overflow-x-auto text-xs whitespace-pre-wrap">
              {body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function planStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "\u2713";
    case "in_progress":
      return "\u25d1";
    case "blocked":
      return "\u2717";
    default:
      return "\u25cb";
  }
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(true);

  const completedCount = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="mx-2 overflow-hidden rounded-lg border border-emerald-500/20 bg-emerald-500/5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Tasks</span>
        <span className="text-muted-foreground text-xs">
          {completedCount}/{todos.length}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-emerald-500/20 px-3 py-1.5">
          <ul className="space-y-0.5">
            {todos.map((todo, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className={cn("mt-px shrink-0", todoStatusColor(todo.status))}>
                  {todoStatusIcon(todo.status)}
                </span>
                <span
                  className={cn(
                    "text-muted-foreground",
                    todo.status === "completed" && "line-through opacity-60",
                  )}
                >
                  {todo.status === "in_progress" ? todo.activeForm || todo.content : todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function todoStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "\u2713";
    case "in_progress":
      return "\u25b6";
    case "blocked":
      return "\u2717";
    default:
      return "\u25cb";
  }
}

function todoStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-500";
    case "in_progress":
      return "text-blue-500";
    case "blocked":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}

function EventItem({ title, body }: { title: string; body: string }) {
  const isError = title.toLowerCase() === "error";

  if (isError) {
    return (
      <div className="bg-destructive/10 border-destructive/30 flex items-start gap-2 rounded-lg border px-3 py-2">
        <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
        <p className="text-destructive text-sm">{body}</p>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground px-3 py-1 text-xs">
      <span className="font-medium">{title}</span>
      {body && <span>: {body}</span>}
    </div>
  );
}

function TypingIndicator() {
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d >= 3 ? 1 : d + 1));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return <div className="text-muted-foreground px-3 py-2 text-sm">{".".repeat(dots)}</div>;
}
