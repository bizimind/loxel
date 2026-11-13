import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { emptyAgentSnapshot, type AgentSnapshot } from "@/api/agent-session-model";

import { applyTranscriptUpdate } from "./agent-session";
import { ClaudeMessageTranslator, type AgentUpdate } from "./claude-message-translator";

/** A real session recorded by `scripts/record-agent-fixture.ts` (Claude Code 2.1.x, Haiku). */
async function fixtureMessages(): Promise<unknown[]> {
  const text = await Bun.file(join(import.meta.dir, "fixtures/claude-sdk-session.ndjson")).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; message?: unknown })
    .filter((entry) => entry.kind === "message")
    .map((entry) => entry.message);
}

function replay(messages: unknown[]): { snapshot: AgentSnapshot; updates: AgentUpdate[] } {
  const translator = new ClaudeMessageTranslator();
  const snapshot = emptyAgentSnapshot("/work/fixture");
  const updates: AgentUpdate[] = [];
  for (const message of messages) {
    for (const update of translator.translate(message)) {
      updates.push(update);
      applyTranscriptUpdate(snapshot, update);
    }
  }
  return { snapshot, updates };
}

describe("ClaudeMessageTranslator on a recorded session", () => {
  test("builds the transcript: question tool, thinking, replies and a Bash call with its output", async () => {
    const { snapshot } = replay(await fixtureMessages());
    const summary = snapshot.items.map((item) =>
      item.kind === "tool" ? `tool:${item.name}:${item.result ? "done" : "running"}` : item.kind,
    );
    expect(summary).toEqual([
      "tool:AskUserQuestion:done",
      "thinking",
      "assistant",
      "tool:Bash:done",
      "assistant",
    ]);
    const replies = snapshot.items.flatMap((item) => (item.kind === "assistant" ? [item] : []));
    expect(replies.map((r) => r.text)).toEqual(["Blue", "fixture-ok"]);
    // The finished blocks replace the streamed ones: nothing is left streaming.
    expect(replies.every((r) => !r.streaming)).toBe(true);
    const bash = snapshot.items.find((item) => item.kind === "tool" && item.name === "Bash");
    expect(bash?.kind === "tool" && bash.result?.text).toContain("fixture-ok");
  });

  test("reports the session, delivery of sent messages and each turn's end", async () => {
    const { updates } = replay(await fixtureMessages());
    const info = updates.find((u) => u.type === "info");
    expect(info?.type === "info" && info.patch.sessionId).toBeString();
    expect(info?.type === "info" && info.patch.agentVersion).toBeString();
    expect(updates.filter((u) => u.type === "user_delivered")).toHaveLength(2);
    const ends = updates.filter((u) => u.type === "turn_end");
    expect(ends).toHaveLength(2);
    expect(ends.every((u) => u.type === "turn_end" && u.error === null)).toBe(true);
  });

  test("streams text into an item before the finished message arrives", async () => {
    const { updates } = replay(await fixtureMessages());
    expect(updates.some((u) => u.type === "append")).toBe(true);
  });
});

describe("ClaudeMessageTranslator", () => {
  test("ignores unknown and malformed messages", () => {
    const translator = new ClaudeMessageTranslator();
    expect(translator.translate(null)).toEqual([]);
    expect(translator.translate({ type: "brand_new_kind", payload: 1 })).toEqual([]);
    expect(translator.translate({ type: "assistant", message: "not an object" })).toEqual([]);
  });

  test("shows history user messages, but not CLI-generated or synthetic ones", () => {
    const translator = new ClaudeMessageTranslator();
    const typed = translator.translate(
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
      { fromHistory: true },
    );
    expect(typed).toEqual([
      { type: "item", item: { kind: "user", id: "u1", text: "hello", imageCount: 0 } },
    ]);
    const generated = translator.translate(
      { type: "user", message: { content: "<command-name>/review</command-name>" } },
      { fromHistory: true },
    );
    expect(generated).toEqual([]);
    const live = translator.translate({ type: "user", message: { content: "hello" } });
    expect(live).toEqual([]);
  });

  test("reports a failed turn with its errors", () => {
    const translator = new ClaudeMessageTranslator();
    const updates = translator.translate({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["boom"],
      total_cost_usd: 0.01,
    });
    expect(updates).toEqual([{ type: "turn_end", error: "boom", costUsd: 0.01 }]);
  });

  test("nests subagent entries under the tool call that started them", () => {
    const translator = new ClaudeMessageTranslator();
    const updates = translator.translate({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: { id: "m1", content: [{ type: "text", text: "from the subagent" }] },
    });
    expect(updates).toEqual([
      {
        type: "item",
        item: {
          kind: "assistant",
          id: "m1:final:0",
          text: "from the subagent",
          parentToolUseId: "toolu_parent",
        },
      },
    ]);
  });
});
