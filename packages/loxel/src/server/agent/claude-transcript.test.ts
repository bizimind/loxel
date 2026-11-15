import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAgentEvent, INITIAL_AGENT_STATE } from "@/api/agent-session-model";

import {
  findTranscript,
  listSessions,
  projectDir,
  summarizeSession,
  transcriptEvents,
} from "./claude-transcript";

const RECORDS = [
  { type: "summary", summary: "not conversation" },
  { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Make a plan" } },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
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
    parentUuid: "a1",
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

describe("conversation chain", () => {
  const rec = (uuid: string, parentUuid: string | null, type: string, content: unknown) => ({
    type,
    uuid,
    parentUuid,
    message:
      type === "assistant"
        ? { id: `m-${uuid}`, role: "assistant", content: [{ type: "text", text: content }] }
        : { role: "user", content },
  });
  // A TUI rewind left "abandoned" in the file; the conversation continues from "first".
  const content = [
    rec("u1", null, "user", "first"),
    rec("a1", "u1", "assistant", "answer"),
    rec("u2", "a1", "user", "abandoned"),
    rec("a2", "u2", "assistant", "abandoned answer"),
    rec("u3", "a1", "user", "kept"),
    rec("a3", "u3", "assistant", "kept answer"),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");

  test("only the chain back from the last message, not an abandoned branch", () => {
    const state = transcriptEvents(content).reduce(applyAgentEvent, INITIAL_AGENT_STATE);
    expect(state.items.map((i) => ("text" in i ? i.text : ""))).toEqual([
      "first",
      "answer",
      "kept",
      "kept answer",
    ]);
  });

  test("a fork point keeps the conversation up to and including it", () => {
    const state = transcriptEvents(content, "a1").reduce(applyAgentEvent, INITIAL_AGENT_STATE);
    expect(state.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["first", "answer"]);
  });
});

describe("session list", () => {
  test("title, first prompt, prompt count and branch from a transcript", () => {
    const content = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        gitBranch: "main",
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        gitBranch: "main",
        message: { role: "user", content: "Fix the scroll" },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "u2",
        gitBranch: "feat/scroll",
        message: { id: "m", content: [{ type: "text", text: "ok" }] },
      },
      { type: "ai-title", aiTitle: "Scroll fix" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(summarizeSession("s1", content, 5)).toEqual({
      id: "s1",
      title: "Scroll fix",
      firstPrompt: "Fix the scroll",
      messageCount: 1,
      branch: "feat/scroll",
      updatedAt: 5,
    });
  });

  test("a project's sessions newest first, empty ones left out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loxel-sessions-"));
    try {
      const project = projectDir(dir, "/Users/dev/my.project");
      expect(project).toBe(join(dir, "projects", "-Users-dev-my-project"));
      await mkdir(project, { recursive: true });
      const prompt = (text: string) =>
        JSON.stringify({
          type: "user",
          uuid: text,
          parentUuid: null,
          message: { role: "user", content: text },
        });
      await Bun.write(join(project, "11111111-1111-4111-8111-111111111111.jsonl"), prompt("older"));
      await Bun.write(join(project, "33333333-3333-4333-8333-333333333333.jsonl"), "");
      await Bun.write(join(project, "22222222-2222-4222-8222-222222222222.jsonl"), prompt("newer"));
      // Set times, so the order never depends on how fast the files were written.
      await utimes(join(project, "11111111-1111-4111-8111-111111111111.jsonl"), 1000, 1000);
      await utimes(join(project, "22222222-2222-4222-8222-222222222222.jsonl"), 2000, 2000);
      const sessions = await listSessions(dir, "/Users/dev/my.project");
      expect(sessions.map((s) => s.firstPrompt)).toEqual(["newer", "older"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
