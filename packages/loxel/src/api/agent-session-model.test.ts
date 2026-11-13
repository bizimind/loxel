import { describe, expect, test } from "bun:test";

import {
  type AgentEvent,
  agentDisplayStatus,
  applyAgentEvent,
  INITIAL_AGENT_STATE,
  parseAgentClientMessage,
} from "./agent-session-model";

const fold = (events: AgentEvent[]) => events.reduce(applyAgentEvent, INITIAL_AGENT_STATE);

describe("applyAgentEvent", () => {
  test("streamed text is replaced by the finished block with the same id", () => {
    const state = fold([
      { type: "delta", id: "m:0", kind: "text", text: "Hel", parentToolUseId: null },
      { type: "delta", id: "m:0", kind: "text", text: "lo", parentToolUseId: null },
    ]);
    expect(state.items).toEqual([
      { kind: "text", id: "m:0", text: "Hello", streaming: true, parentToolUseId: null },
    ]);
    const done = applyAgentEvent(state, {
      type: "item",
      item: { kind: "text", id: "m:0", text: "Hello!", streaming: false, parentToolUseId: null },
    });
    expect(done.items).toHaveLength(1);
    expect(done.items[0]).toMatchObject({ text: "Hello!", streaming: false });
  });

  test("an interrupted turn stops streaming and keeps the text it got", () => {
    const state = fold([
      { type: "delta", id: "m:0", kind: "thinking", text: "hmm", parentToolUseId: null },
      { type: "turn_result", isError: true, costUsd: 0.01, errorText: "Interrupted" },
    ]);
    expect(state.items[0]).toMatchObject({ text: "hmm", streaming: false });
    expect(state.items[1]).toMatchObject({ kind: "notice", level: "error", text: "Interrupted" });
  });

  test("a tool result lands on its tool", () => {
    const state = fold([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "t1",
          name: "Bash",
          input: {},
          result: null,
          parentToolUseId: null,
        },
      },
      { type: "tool_result", toolUseId: "t1", text: "ok", isError: false },
    ]);
    expect(state.items[0]).toMatchObject({ result: { text: "ok", isError: false } });
  });

  test("a queued message stops being queued once delivered", () => {
    const state = fold([
      { type: "user_message", id: "u1", text: "next", imageCount: 0, queued: true },
      { type: "user_message_delivered", id: "u1" },
    ]);
    expect(state.items[0]).toMatchObject({ queued: false });
  });

  test("a pending request shows as needs input until answered, whatever the turn does", () => {
    const request = {
      kind: "plan" as const,
      requestId: "r1",
      toolUseId: "t1",
      input: {},
      plan: "p",
    };
    const asking = fold([
      { type: "status", status: "working" },
      { type: "request", request },
      { type: "status", status: "idle" },
    ]);
    expect(agentDisplayStatus(asking)).toBe("needs_input");
    const answered = applyAgentEvent(asking, { type: "request_resolved", requestId: "r1" });
    expect(agentDisplayStatus(answered)).toBe("idle");
  });

  test("an exit with an error fails the session and drops what it asked", () => {
    const state = fold([{ type: "exited", error: "boom" }]);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("boom");
  });
});

describe("parseAgentClientMessage", () => {
  test("accepts a well-formed message and rejects unknown shapes", () => {
    expect(parseAgentClientMessage({ type: "set_permission_mode", mode: "plan" })).toEqual({
      type: "set_permission_mode",
      mode: "plan",
    });
    expect(parseAgentClientMessage({ type: "set_permission_mode", mode: "yolo" })).toBeNull();
    expect(
      parseAgentClientMessage({ type: "send", id: "x", text: "", delivery: "queue" }),
    ).toBeNull();
  });
});
