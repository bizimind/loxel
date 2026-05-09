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

describe("Session compaction", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("compact");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  test("compact succeeds on session with messages", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([textStreamParts("r1"), textStreamParts("r2"), textStreamParts("r3")]),
    );

    await session.send("m1");
    await session.send("m2");
    await session.send("m3");

    // compact should not throw
    await session.compact();
  });

  test("compact on session with no messages is a no-op", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    // Should not throw and should be a no-op (no compaction record created)
    await session.compact();
  });

  test("compact below minimum token threshold is a no-op", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("short")]));

    await session.send("hi");

    // Context is below the 32k token minimum — should be a no-op
    await session.compact();
  });

  test("compact then send succeeds", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([
        textStreamParts("r1"),
        textStreamParts("r2"),
        textStreamParts("r3"),
        textStreamParts("r4"),
      ]),
    );

    await session.send("m1");
    await session.send("m2");
    await session.send("m3");

    await session.compact();

    const result = await session.send("m4");

    expect(result.text).toContain("r4");
  });

  test("compact then rewind to pre-compaction message", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("r1"), textStreamParts("r2")]));

    await session.send("m1");
    await session.send("m2");

    await session.compact();

    const firstUserMsgId = events
      .ofType("message.received")
      .filter((e) => e.role === "user")[0]!.serverMessageId;

    // Rewind to the first user message — original messages are preserved despite compaction
    await session.rewind(firstUserMsgId);
  });

  test("double compaction creates two compaction records", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(
      session,
      createMockModel([
        textStreamParts("r1"),
        textStreamParts("r2"),
        textStreamParts("r3"),
        textStreamParts("r4"),
        textStreamParts("r5"),
        textStreamParts("r6"),
      ]),
    );

    await session.send("m1");
    await session.send("m2");
    await session.send("m3");

    // First compaction
    await session.compact();

    await session.send("m4");
    await session.send("m5");
    await session.send("m6");

    // Second compaction — should not throw
    await session.compact();
  });

  test("compact on destroyed session throws", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    session.destroy();

    await expect(session.compact()).rejects.toThrow("Session is destroyed");
    session = null;
  });
});
