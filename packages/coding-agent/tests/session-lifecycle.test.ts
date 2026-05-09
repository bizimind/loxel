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

describe("Session lifecycle", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("lifecycle");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Basic lifecycle
  // -------------------------------------------------------------------------

  test("creates session with valid id", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    expect(session.id).toBeTruthy();
    expect(typeof session.id).toBe("string");
  });

  test("send() returns SendResult with text, messageId, and runId", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("Hello!")]));

    const result = await session.send("hi");

    expect(result.text).toContain("Hello!");
    expect(typeof result.messageId).toBe("string");
    expect(typeof result.runId).toBe("string");
  });

  test("rejects send() on destroyed session", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    session.destroy();

    await expect(session.send("hi")).rejects.toThrow("Session is destroyed");
    session = null;
  });

  test("rejects concurrent send() calls", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    const doStreamStarted = Promise.withResolvers<void>();
    const unblockStream = Promise.withResolvers<void>();
    const model = new MockLanguageModelV3({
      doStream: async () => {
        doStreamStarted.resolve();
        await unblockStream.promise;
        return { stream: mockStream(textStreamParts("late")) };
      },
    });
    patchSessionModel(session, model);

    // Fire first send (blocks in doStream)
    const first = session.send("first");
    // Wait for the model to actually start before testing concurrency
    await doStreamStarted.promise;
    // Second should reject immediately
    await expect(session.send("second")).rejects.toThrow("A run is already in progress");

    // Unblock the first send so it can complete
    unblockStream.resolve();
    await first;
  });

  test("destroy() rejects pending send()", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    const doStreamStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV3({
      doStream: () => {
        doStreamStarted.resolve();
        return new Promise(() => {}); // never resolves
      },
    });
    patchSessionModel(session, model);

    const pending = session.send("waiting");
    await doStreamStarted.promise;
    session.destroy();

    await expect(pending).rejects.toThrow("Session destroyed");
    session = null;
  });

  test("destroy() is idempotent", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    session.destroy();
    session.destroy(); // should not throw
    session = null;
  });

  // -------------------------------------------------------------------------
  // Empty/no-arg send
  // -------------------------------------------------------------------------

  test("send('') does not add user message but triggers agent completion", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("empty response")]));

    await session.send("");

    const userMessages = events.ofType("message.received").filter((e) => e.role === "user");
    expect(userMessages.length).toBe(0);

    expect(events.ofType("run.started").length).toBe(1);
    expect(events.ofType("run.completed").length).toBe(1);
  });

  test("send() with no arguments does not add user message but triggers agent completion", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("no-arg response")]));

    await session.send();

    const userMessages = events.ofType("message.received").filter((e) => e.role === "user");
    expect(userMessages.length).toBe(0);

    expect(events.ofType("run.started").length).toBe(1);
    expect(events.ofType("run.completed").length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Message types
  // -------------------------------------------------------------------------

  test("send() with MessagePart array succeeds", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("got parts")]));

    const result = await session.send([{ type: "text", text: "hello" }]);

    expect(result.text).toBeTruthy();
    expect(typeof result.messageId).toBe("string");
    expect(typeof result.runId).toBe("string");
  });

  test("send() with mixed text and image MessageParts succeeds", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("described")]));

    const result = await session.send([
      { type: "text", text: "describe" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);

    expect(result.text).toBeTruthy();
    expect(typeof result.messageId).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Recovery after failed/cancelled runs
  // -------------------------------------------------------------------------

  test("send() after a failed run allows a new send()", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    // First send with a model that throws
    const failingModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("model exploded");
      },
    });
    patchSessionModel(session, failingModel);

    await expect(session.send("fail")).rejects.toThrow();

    // Second send with a working model should succeed (pendingRun was cleared by run.failed)
    patchSessionModel(session, createMockModel([textStreamParts("recovered")]));
    const result = await session.send("retry");

    expect(result.text).toContain("recovered");
  });

  test("send() after a cancelled run allows a new send()", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    // First send with abort — use a model that blocks in doStream
    const controller = new AbortController();
    const doStreamStarted = Promise.withResolvers<void>();
    const blockingModel = new MockLanguageModelV3({
      doStream: () => {
        doStreamStarted.resolve();
        return new Promise(() => {}); // never resolves
      },
    });
    patchSessionModel(session, blockingModel);

    const pending = session.send("cancel me", { signal: controller.signal });
    const caught = pending.catch((err: Error) => err);

    // Wait for the model to actually start streaming before aborting
    await doStreamStarted.promise;
    controller.abort();
    const rejection = await caught;
    expect(rejection).toBeInstanceOf(Error);

    // Second send with a working model should succeed (pendingRun was cleared by abort)
    patchSessionModel(session, createMockModel([textStreamParts("after cancel")]));
    const result = await session.send("retry after cancel");

    expect(result.text).toContain("after cancel");
  });

  // -------------------------------------------------------------------------
  // Send options
  // -------------------------------------------------------------------------

  test("modelProfile option is forwarded", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("planned")]));

    const result = await session.send("plan something", { modelProfile: "planner" });

    expect(result.text).toContain("planned");
    expect(events.ofType("run.started").length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  test("after destroy, send/rewind/fork/compact all throw", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    session.destroy();

    await expect(session.send("hi")).rejects.toThrow("Session is destroyed");
    await expect(session.rewind("any-id")).rejects.toThrow("Session is destroyed");
    await expect(session.fork()).rejects.toThrow("Session is destroyed");
    await expect(session.compact()).rejects.toThrow("Session is destroyed");
    session = null;
  });
});
