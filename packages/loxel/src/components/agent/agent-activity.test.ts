import { describe, expect, test } from "bun:test";

import type { TranscriptItem } from "@/api/agent-session-model";

import {
  activityRunning,
  activitySummary,
  editDiffLines,
  transcriptBlocks,
} from "./agent-activity";
import { nextHighlight } from "./AgentComposer";

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
