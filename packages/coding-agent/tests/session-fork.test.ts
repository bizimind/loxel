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
  toolCallStreamParts,
  path,
} from "./helpers/mock-session.ts";

describe("Session fork", () => {
  let env: TestEnv;
  let session: Session | null;
  const forkedSessions: Session[] = [];

  beforeEach(async () => {
    env = await setupTestEnv("fork");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    for (const f of forkedSessions.splice(0)) f.destroy();
    await env.cleanup();
  });

  test("fork creates session with different id", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("original")]));
    await session.send("hello");

    const forked = await session.fork();
    forkedSessions.push(forked);

    expect(forked.id).not.toBe(session.id);
    expect(typeof forked.id).toBe("string");
  });

  test("forked session can send independently", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("original")]));
    await session.send("first");

    const forked = await session.fork();
    forkedSessions.push(forked);
    patchSessionModel(forked, createMockModel([textStreamParts("forked response")]));

    const result = await forked.send("forked message");

    expect(result.text).toContain("forked response");
  });

  test("fork from specific messageId", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("r1"), textStreamParts("r2")]));
    await session.send("m1");
    await session.send("m2");

    const firstUserMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;
    const forked = await session.fork(firstUserMsgId);
    forkedSessions.push(forked);

    expect(forked.id).not.toBe(session.id);
  });

  test("fork of a fork preserves nested lineage", async () => {
    const events = collectEvents();
    // Session A
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("response A")]));
    await session.send("message A");

    // Fork to B
    const sessionB = await session.fork();
    forkedSessions.push(sessionB);
    patchSessionModel(sessionB, createMockModel([textStreamParts("response B")]));
    await sessionB.send("message B");

    // Fork B to C
    const sessionC = await sessionB.fork();
    forkedSessions.push(sessionC);

    expect(sessionC.id).not.toBe(session.id);
    expect(sessionC.id).not.toBe(sessionB.id);

    // C can send independently
    patchSessionModel(sessionC, createMockModel([textStreamParts("response C")]));
    const result = await sessionC.send("message C");
    expect(result.text).toContain("response C");
  });

  test("fork after rewind starts from rewound position", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([
        textStreamParts("first response"),
        textStreamParts("second response"),
        textStreamParts("forked after rewind"),
      ]),
    );

    await session.send("first message");
    await session.send("second message");

    const firstUserMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    // Rewind to the first user message
    await session.rewind(firstUserMsgId);

    // Fork from the rewound position (no messageId — uses current head)
    const forked = await session.fork();
    forkedSessions.push(forked);
    patchSessionModel(forked, createMockModel([textStreamParts("forked after rewind")]));

    const result = await forked.send("divergent from rewound point");
    expect(result.text).toContain("forked after rewind");
  });

  test("fork with invalid messageId throws with context", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("setup")]));
    await session.send("hello");

    // Current bug: fork() hangs when the store throws because the error doesn't
    // propagate through the runtime's error listener. Use a timeout to avoid blocking.
    const forkPromise = session.fork("nonexistent-msg-id");
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("fork should have rejected but timed out")), 5000);
    });
    await expect(Promise.race([forkPromise, timeout])).rejects.toThrow(/nonexistent-msg-id/);
  });

  test("forked session has independent permission store", async () => {
    let approvalCount = 0;
    const events = collectEvents({
      "approval.requested": (e) => {
        approvalCount += 1;
        setTimeout(() => e.respond("allow_this_session"), 50);
      },
    });

    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    const file1 = path.join(env.workspaceRoot, "source-file.txt");
    patchSessionModel(
      session,
      createMockModel([
        toolCallStreamParts("Write", { file_path: file1, content: "source" }),
        textStreamParts("Written in source"),
      ]),
    );

    await session.send("write a file");

    // Source session should have requested approval once
    expect(approvalCount).toBe(1);

    // Fork the session — forked session has new ID so allow_this_session doesn't carry
    const forked = await session.fork();
    forkedSessions.push(forked);

    const file2 = path.join(env.workspaceRoot, "forked-file.txt");
    patchSessionModel(
      forked,
      createMockModel([
        toolCallStreamParts("Write", { file_path: file2, content: "forked" }),
        textStreamParts("Written in forked"),
      ]),
    );

    await forked.send("write in fork");

    // Forked session should have requested approval again (independent permission store)
    expect(approvalCount).toBe(2);
  });

  test("parent destroy does not affect forked session", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("parent response")]));
    await session.send("parent message");

    const forked = await session.fork();
    forkedSessions.push(forked);

    // Destroy parent
    session.destroy();
    session = null;

    // Forked session should still work
    patchSessionModel(forked, createMockModel([textStreamParts("forked still works")]));
    const result = await forked.send("message after parent destroyed");
    expect(result.text).toContain("forked still works");
  });

  test("forked session destroy does not affect parent", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([textStreamParts("parent r1"), textStreamParts("parent r2")]),
    );
    await session.send("parent message");

    const forked = await session.fork();
    // Don't push to forkedSessions — we destroy it manually
    forked.destroy();

    // Parent should still work
    const result = await session.send("parent after fork destroyed");
    expect(result.text).toContain("parent r2");
  });

  test("fork during pending send does not abort source run", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    // First send to establish conversation
    patchSessionModel(session, createMockModel([textStreamParts("setup")]));
    await session.send("setup");

    // Create a blocking model for the second send
    const doStreamStarted = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const blockingModel = new MockLanguageModelV3({
      doStream: async () => {
        doStreamStarted.resolve();
        await unblock.promise;
        return { stream: mockStream(textStreamParts("source completed")) };
      },
    });
    patchSessionModel(session, blockingModel);

    // Start a blocking send
    const pendingSend = session.send("blocking message");
    await doStreamStarted.promise;

    // Fork while send is pending — fork should succeed
    const forked = await session.fork();
    forkedSessions.push(forked);
    expect(typeof forked.id).toBe("string");

    // Unblock the source model
    unblock.resolve();

    // Source send should complete successfully
    const sourceResult = await pendingSend;
    expect(sourceResult.text).toContain("source completed");

    // Both sessions are independently usable
    patchSessionModel(forked, createMockModel([textStreamParts("forked independent")]));
    const forkedResult = await forked.send("forked message");
    expect(forkedResult.text).toContain("forked independent");
  });
});
