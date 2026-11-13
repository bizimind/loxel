/**
 * How the transcript reads: assistant prose and user messages as they are, and the tool calls and
 * thinking between them gathered into activity groups, one muted summary line each ("Read 3 files
 * · ran 2 commands"). Pure, so the grouping is tested without rendering.
 */
import type { TranscriptItem } from "@/api/agent-session-model";
import { isRecord } from "@/lib/is-record";

export type ActivityItem = Extract<TranscriptItem, { kind: "tool" } | { kind: "thinking" }>;

export type TranscriptBlock =
  | { kind: "item"; item: Exclude<TranscriptItem, ActivityItem> }
  | { kind: "activity"; id: string; items: ActivityItem[] };

function isActivity(item: TranscriptItem): item is ActivityItem {
  return item.kind === "tool" || item.kind === "thinking";
}

/** Consecutive tool calls and thinking become one activity block. */
export function transcriptBlocks(items: readonly TranscriptItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (!isActivity(item)) {
      blocks.push({ kind: "item", item });
    } else if (last?.kind === "activity") {
      last.items.push(item);
    } else {
      blocks.push({ kind: "activity", id: item.id, items: [item] });
    }
  }
  return blocks;
}

/** What kind of work a tool does, for its icon and its share of a group's summary. */
export type ToolKind = "read" | "edit" | "run" | "search" | "web" | "agent" | "ask" | "other";

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  BashOutput: "run",
  Grep: "search",
  Glob: "search",
  ToolSearch: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "agent",
  Agent: "agent",
  AskUserQuestion: "ask",
  ExitPlanMode: "ask",
};

export function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? "other";
}

const SUMMARY: Record<ToolKind, (n: number) => string> = {
  read: (n) => `read ${n} file${n === 1 ? "" : "s"}`,
  edit: (n) => `edited ${n} file${n === 1 ? "" : "s"}`,
  run: (n) => `ran ${n} command${n === 1 ? "" : "s"}`,
  search: (n) => `searched ${n} time${n === 1 ? "" : "s"}`,
  web: (n) => `fetched ${n} page${n === 1 ? "" : "s"}`,
  agent: (n) => `ran ${n} agent${n === 1 ? "" : "s"}`,
  ask: (n) => `asked ${n} time${n === 1 ? "" : "s"}`,
  other: (n) => `used ${n} tool${n === 1 ? "" : "s"}`,
};

/** One line for a group: what it did, by kind, in the order the kinds first appear. */
export function activitySummary(items: readonly ActivityItem[]): string {
  const counts = new Map<ToolKind | "thinking", number>();
  for (const item of items) {
    const key = item.kind === "thinking" ? "thinking" : toolKind(item.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) =>
    kind === "thinking" ? "thought" : SUMMARY[kind](n),
  );
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a group is still at work: a tool without its result, or a thought still streaming. */
export function activityRunning(items: readonly ActivityItem[]): boolean {
  return items.some((item) => (item.kind === "tool" ? item.result === null : item.streaming));
}

/** Old and new text of an edit as diff lines: every old line removed, every new line added. */
export function editDiffLines(input: unknown): { sign: "-" | "+"; text: string }[] | null {
  if (!isRecord(input)) return null;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const lines: { sign: "-" | "+"; text: string }[] = [];
  for (const edit of edits) {
    if (!isRecord(edit)) continue;
    const { old_string: oldText, new_string: newText } = edit;
    if (typeof oldText !== "string" || typeof newText !== "string") continue;
    if (oldText) lines.push(...oldText.split("\n").map((text) => ({ sign: "-" as const, text })));
    lines.push(...newText.split("\n").map((text) => ({ sign: "+" as const, text })));
  }
  return lines.length > 0 ? lines : null;
}
