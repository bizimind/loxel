import { describe, expect, test } from "bun:test";

import type { TranscriptItem } from "@/api/agent-session-model";

import {
  activityRunning,
  activitySummary,
  editDiffLines,
  transcriptBlocks,
} from "./agent-activity";
import { historyStep, nextHighlight } from "./AgentComposer";

const tool = (id: string, name: string, done = true): TranscriptItem => ({
  kind: "tool",
  id,
  name,
  input: {},
  result: done ? { text: "", isError: false } : null,
  parentToolUseId: null,
});

describe("transcript blocks", () => {
  test("consecutive tool calls form one group, summarized by kind", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u", text: "go", imageCount: 0, queued: false },
      tool("1", "Read"),
      tool("2", "Read"),
      tool("3", "Bash"),
      tool("4", "Read", false),
      { kind: "text", id: "t", text: "done", streaming: false, parentToolUseId: null },
    ];
    const blocks = transcriptBlocks(items);
    expect(blocks.map((b) => b.kind)).toEqual(["item", "activity", "item"]);
    const group = blocks[1];
    if (group?.kind !== "activity") throw new Error("no group");
    expect(activitySummary(group.items)).toBe("Read 3 files · ran 1 command");
    expect(activityRunning(group.items)).toBe(true);
  });

  test("an edit's diff lists the old lines removed and the new ones added", () => {
    expect(editDiffLines({ old_string: "a\nb", new_string: "c" })).toEqual([
      { sign: "-", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "c" },
    ]);
    expect(editDiffLines({ file_path: "/x" })).toBeNull();
  });
});

describe("command list navigation", () => {
  test("arrows wrap, Home and End jump, pages stop at the ends", () => {
    expect(nextHighlight("ArrowDown", 4, 5)).toBe(0);
    expect(nextHighlight("ArrowUp", 0, 5)).toBe(4);
    expect(nextHighlight("End", 0, 5)).toBe(4);
    expect(nextHighlight("Home", 3, 5)).toBe(0);
    expect(nextHighlight("PageDown", 2, 30)).toBe(10);
    expect(nextHighlight("PageUp", 3, 30)).toBe(0);
    expect(nextHighlight("a", 0, 5)).toBeNull();
  });
});

describe("prompt history steps", () => {
  const history = ["a", "b", "c"];

  test("Up walks back from the draft, Down walks forward and back to the draft", () => {
    expect(historyStep(history, null, -1)).toEqual({ index: 2 });
    expect(historyStep(history, 2, -1)).toEqual({ index: 1 });
    expect(historyStep(history, 0, -1)).toBeNull();
    expect(historyStep(history, 1, 1)).toEqual({ index: 2 });
    expect(historyStep(history, 2, 1)).toEqual({ index: null });
    expect(historyStep(history, null, 1)).toBeNull();
    expect(historyStep([], null, -1)).toBeNull();
  });
});

describe("session search", () => {
  test("every word must match the title, first prompt or branch", async () => {
    const { filterSessions } = await import("./AgentSessionPicker");
    const sessions = [
      {
        id: "1",
        title: "Scroll fix",
        firstPrompt: "Fix the scroll",
        messageCount: 2,
        branch: "feat/scroll",
        updatedAt: 1,
      },
      {
        id: "2",
        title: null,
        firstPrompt: "Add a shortcut",
        messageCount: 1,
        branch: "main",
        updatedAt: 2,
      },
    ];
    expect(filterSessions(sessions, "scroll feat").map((s) => s.id)).toEqual(["1"]);
    expect(filterSessions(sessions, "main").map((s) => s.id)).toEqual(["2"]);
    expect(filterSessions(sessions, "").length).toBe(2);
  });
});

describe("fork point", () => {
  test("through the selected message's turn: the entry before the next message", async () => {
    const { forkPoint } = await import("./AgentRewind");
    const messages = [
      { kind: "user" as const, id: "u1", text: "a", imageCount: 0, queued: false, resumeAt: null },
      { kind: "user" as const, id: "u2", text: "b", imageCount: 0, queued: false, resumeAt: "a1" },
    ];
    expect(forkPoint(messages, "u1")).toBe("a1");
    expect(forkPoint(messages, "u2")).toBeUndefined();
  });
});
