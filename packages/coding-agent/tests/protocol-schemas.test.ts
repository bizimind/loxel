import { describe, expect, test } from "bun:test";

import { protocolRequestSchema } from "../src/protocol/schemas.ts";

describe("protocolRequestSchema", () => {
  test("parses session.start", () => {
    const parsed = protocolRequestSchema.parse({
      type: "session.start",
      request_id: "req_1",
      workspace_root: "/tmp/workspace",
      profile: "execute",
      declared_tools: ["Read", "Write"],
    });

    expect(parsed.type).toBe("session.start");
  });

  test("rejects unknown fields", () => {
    const result = protocolRequestSchema.safeParse({
      type: "session.compact",
      request_id: "req_2",
      session_id: "session_1",
      nope: true,
    });

    expect(result.success).toBe(false);
  });

  test("rejects invalid session_id format", () => {
    const result = protocolRequestSchema.safeParse({
      type: "session.get",
      request_id: "req_bad_session",
      session_id: "../../etc/passwd",
    });

    expect(result.success).toBe(false);
  });

  test("parses session list/get/resume requests", () => {
    expect(protocolRequestSchema.parse({ type: "session.list", request_id: "req_list" }).type).toBe(
      "session.list",
    );

    expect(
      protocolRequestSchema.parse({
        type: "session.get",
        request_id: "req_get",
        session_id: "session_1",
      }).type,
    ).toBe("session.get");

    expect(
      protocolRequestSchema.parse({
        type: "session.resume",
        request_id: "req_resume",
        session_id: "session_1",
        rewind_to_message_id: "msg_1",
      }).type,
    ).toBe("session.resume");
  });
});
