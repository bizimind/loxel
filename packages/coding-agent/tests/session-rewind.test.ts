import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type TestEnv,
  Session,
  collectEvents,
  createMockModel,
  mockStream,
  patchSessionModel,
  setupTestEnv,
  textStreamParts,
} from "./helpers/mock-session.ts";

describe("Session rewind", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("rewind");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  test("rewind completes without error", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("first")]));

    await session.send("hello");

    const userMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    await session.rewind(userMsgId);
  });

  test("after rewind, can send on divergent branch", async () => {
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

    const r2 = await session.send("different message");

    expect(r2.text).toContain("divergent response");
  });

  test("rewind to invalid message ID throws with context", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("first")]));

    await session.send("hello");

    await expect(session.rewind("nonexistent-msg-id")).rejects.toThrow("Message ID not found");

    // Verify the error includes both session ID and the bad message ID
    try {
      await session.rewind("nonexistent-msg-id");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain(session!.id);
      expect(msg).toContain("nonexistent-msg-id");
    }
  });

  test("rewind to first message in multi-message conversation", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([
        textStreamParts("r1"),
        textStreamParts("r2"),
        textStreamParts("r3"),
        textStreamParts("divergent after rewind"),
      ]),
    );

    await session.send("m1");
    await session.send("m2");
    await session.send("m3");

    const firstUserMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    await session.rewind(firstUserMsgId);

    const result = await session.send("new message from beginning");

    expect(result.text).toContain("divergent after rewind");
  });

  test("multiple rewinds create tree of branches", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([
        textStreamParts("response A"),
        textStreamParts("response B"),
        textStreamParts("response C"),
      ]),
    );

    // Send message A (branch 1)
    await session.send("message A");
    const userMsgIdA = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    // Rewind to A's user msg, send B (branch 2)
    await session.rewind(userMsgIdA);
    const resultB = await session.send("message B");
    expect(resultB.text).toContain("response B");

    // Rewind to A's user msg again, send C (branch 3)
    await session.rewind(userMsgIdA);
    const resultC = await session.send("message C");
    expect(resultC.text).toContain("response C");

    // All three sends produced run.completed events
    expect(events.ofType("run.completed").length).toBe(3);
  });

  test("rewind preserves original messages", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([textStreamParts("first response"), textStreamParts("second response")]),
    );

    await session.send("first message");
    await session.send("second message");

    const firstUserMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    // Capture the second message's serverMessageId (should still exist after rewind)
    const secondUserMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[1]!.serverMessageId;

    await session.rewind(firstUserMsgId);

    // After rewind, send a new message on the divergent branch
    patchSessionModel(session, createMockModel([textStreamParts("divergent")]));
    await session.send("divergent message");

    // Verify the original second message still exists in session store
    // by checking we have 3+ user messages (original two + divergent)
    const allUserMsgs = events.ofType("message.received").filter((e) => e.role === "user");
    expect(allUserMsgs.length).toBe(3);
    // The second user message ID should still be in the events (not deleted)
    expect(allUserMsgs.some((e) => e.serverMessageId === secondUserMsgId)).toBe(true);
  });

  test("rewind aborts current run then rewinds", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    // First send completes normally
    patchSessionModel(session, createMockModel([textStreamParts("first")]));
    await session.send("setup");

    const userMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    // Create a blocking model for the second send
    const doStreamStarted = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const blockingModel = new MockLanguageModelV3({
      doStream: async () => {
        doStreamStarted.resolve();
        await unblock.promise;
        return { stream: mockStream(textStreamParts("should not arrive")) };
      },
    });
    patchSessionModel(session, blockingModel);

    // Start a blocking send — attach catch handler immediately to avoid unhandled rejection
    const pendingSend = session.send("blocking message");
    const caught = pendingSend.catch((err: Error) => err);

    // Wait for the model to actually start before rewinding
    await doStreamStarted.promise;

    // Rewind while send is pending — expected: pending send rejects, rewind succeeds
    await session.rewind(userMsgId);

    // The pending send should have been aborted/cancelled
    const rejection = await caught;
    expect(rejection).toBeInstanceOf(Error);

    // Unblock in case the stream is still waiting
    unblock.resolve();

    // After rewind, session accepts a new send
    patchSessionModel(session, createMockModel([textStreamParts("after rewind")]));
    const result = await session.send("new message");
    expect(result.text).toContain("after rewind");
  });

  test("rewind on destroyed session throws", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    session.destroy();

    await expect(session.rewind("any-id")).rejects.toThrow("Session is destroyed");
    session = null;
  });
});
