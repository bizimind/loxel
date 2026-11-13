import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAgentEvent, INITIAL_AGENT_STATE } from "@/api/agent-session-model";

import { findTranscript, transcriptEvents } from "./claude-transcript";

const RECORDS = [
  { type: "summary", summary: "not conversation" },
  { type: "user", uuid: "u1", message: { role: "user", content: "Make a plan" } },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [
        { type: "text", text: "Reading first." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/a.ts" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u2",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
  },
  "not json",
];

describe("transcriptEvents", () => {
  test("rebuilds the conversation from transcript records", () => {
    const content = RECORDS.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
    const state = transcriptEvents(content).reduce(applyAgentEvent, INITIAL_AGENT_STATE);
    expect(state.items.map((item) => item.kind)).toEqual(["user", "text", "tool"]);
    expect(state.items[2]).toMatchObject({ name: "Read", result: { text: "x" } });
  });
});

describe("findTranscript", () => {
  test("finds a session's file under any project directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loxel-claude-"));
    try {
      await mkdir(join(dir, "projects", "-Users-dev-project"), { recursive: true });
      const id = "4a1583e2-ed62-4861-b4fa-0f48a6dc1579";
      await Bun.write(join(dir, "projects", "-Users-dev-project", `${id}.jsonl`), "");
      expect(await findTranscript(dir, id)).toBe(
        join(dir, "projects", "-Users-dev-project", `${id}.jsonl`),
      );
      expect(await findTranscript(dir, "00000000-0000-4000-8000-000000000000")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
