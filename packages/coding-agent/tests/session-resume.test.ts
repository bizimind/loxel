import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type TestEnv,
  Session,
  collectEvents,
  createMockModel,
  patchSessionModel,
  setupTestEnv,
  textStreamParts,
} from "./helpers/mock-session.ts";

describe("Session resume", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("resume");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  test("resume loads existing session by id", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("initial")]));
    await session.send("setup");

    const sessionId = session.id;
    session.destroy();

    const resumeEvents = collectEvents();
    session = await Session.resume(sessionId, {
      workspaceRoot: env.workspaceRoot,
      handlers: resumeEvents.handlers,
    });

    expect(session.id).toBe(sessionId);
  });

  test("resumed session can send()", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("initial")]));
    await session.send("setup");

    const sessionId = session.id;
    session.destroy();

    const resumeEvents = collectEvents();
    session = await Session.resume(sessionId, {
      workspaceRoot: env.workspaceRoot,
      handlers: resumeEvents.handlers,
    });
    patchSessionModel(session, createMockModel([textStreamParts("resumed response")]));

    const result = await session.send("after resume");

    expect(result.text).toContain("resumed response");
  });

  test("resume preserves message parent chain", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("r1"), textStreamParts("r2")]));

    await session.send("first");
    await session.send("second");

    const sessionId = session.id;
    session.destroy();

    const resumeEvents = collectEvents();
    session = await Session.resume(sessionId, {
      workspaceRoot: env.workspaceRoot,
      handlers: resumeEvents.handlers,
    });
    patchSessionModel(session, createMockModel([textStreamParts("r3")]));

    await session.send("third");

    const thirdUserMsg = resumeEvents
      .ofType("message.received")
      .filter((e) => e.role === "user")[0];
    expect(thirdUserMsg?.parentMessageId).not.toBeNull();
  });

  test("resume after rewind continues on rewound branch", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([textStreamParts("first response"), textStreamParts("divergent response")]),
    );

    await session.send("original message");

    const userMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;
    await session.rewind(userMsgId);

    const sessionId = session.id;
    session.destroy();

    const resumeEvents = collectEvents();
    session = await Session.resume(sessionId, {
      workspaceRoot: env.workspaceRoot,
      handlers: resumeEvents.handlers,
    });
    patchSessionModel(session, createMockModel([textStreamParts("after rewind resume")]));

    const result = await session.send("new message on rewound branch");

    expect(result.text).toContain("after rewind resume");
  });

  test("resume non-existent session ID throws", async () => {
    const resumeEvents = collectEvents();

    await expect(
      Session.resume("does-not-exist-session-id", {
        workspaceRoot: env.workspaceRoot,
        handlers: resumeEvents.handlers,
      }),
    ).rejects.toThrow("Session ID not found");
  });

  test("resume preserves compaction state", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([textStreamParts("r1"), textStreamParts("r2"), textStreamParts("r3")]),
    );

    await session.send("m1");
    await session.send("m2");
    await session.send("m3");

    await session.compact();

    const sessionId = session.id;
    session.destroy();

    const resumeEvents = collectEvents();
    session = await Session.resume(sessionId, {
      workspaceRoot: env.workspaceRoot,
      handlers: resumeEvents.handlers,
    });
    patchSessionModel(session, createMockModel([textStreamParts("r4")]));

    const result = await session.send("m4");

    expect(result.text).toContain("r4");
  });
});
