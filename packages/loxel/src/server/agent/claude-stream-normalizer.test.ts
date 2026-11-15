import { describe, expect, test } from "bun:test";

import { ClaudeStreamNormalizer } from "./claude-stream-normalizer";

const assistant = (uuid: string) => ({
  type: "assistant",
  uuid,
  parent_tool_use_id: null,
  message: { id: `msg-${uuid}`, content: [{ type: "text", text: "ok" }] },
});

describe("ClaudeStreamNormalizer resume points", () => {
  test("each user message records the entry before it; a sent one when its echo arrives", () => {
    const normalizer = new ClaudeStreamNormalizer();
    const first = normalizer.normalize({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "hi" },
    });
    expect(first).toEqual([
      { type: "user_message", id: "u1", text: "hi", imageCount: 0, queued: false, resumeAt: null },
    ]);
    normalizer.normalize(assistant("a1"));
    // A subagent's messages are not entries of the main conversation.
    normalizer.normalize({ ...assistant("sub"), parent_tool_use_id: "task" });
    normalizer.noteSent("u2");
    const echo = normalizer.normalize({
      type: "user",
      uuid: "u2",
      isReplay: true,
      message: { role: "user", content: [{ type: "text", text: "next" }] },
    });
    expect(echo).toEqual([{ type: "user_message_delivered", id: "u2", resumeAt: "a1" }]);
  });
});
