import { MockLanguageModelV4 } from "ai/test";
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

describe("Session abort signal", () => {
  let env: TestEnv;
  let session: Session | null;

  beforeEach(async () => {
    env = await setupTestEnv("abort");
    session = null;
  });

  afterEach(async () => {
    session?.destroy();
    session = null;
    await env.cleanup();
  });

  test("already-aborted signal rejects send() immediately", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("unreachable")]));

    const controller = new AbortController();
    controller.abort();

    await expect(session.send("hi", { signal: controller.signal })).rejects.toThrow(
      "Signal already aborted",
    );

    // Model should never have been called — no run events
    expect(events.ofType("run.started").length).toBe(0);
  });

  test("abort mid-run cancels the run", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    const doStreamStarted = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        doStreamStarted.resolve();
        await unblock.promise;

        return { stream: mockStream(textStreamParts("late")) };
      },
    });
    patchSessionModel(session, model);

    const controller = new AbortController();
    const pending = session.send("hello", { signal: controller.signal });

    // Attach catch handler before aborting to capture the rejection
    let rejection: Error | null = null;
    const caught = pending.catch((err: Error) => {
      rejection = err;
    });

    // Wait for the model to actually start before aborting
    await doStreamStarted.promise;

    controller.abort();
    await caught;

    expect(rejection).not.toBeNull();
    expect(rejection!.message).toBe("Run cancelled");
    expect(events.ofType("run.cancelled").length).toBeGreaterThan(0);

    // Clean up: unblock so the model promise resolves and doesn't leak
    unblock.resolve();
  });

  test("abort signal listener is cleaned up after successful send()", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    patchSessionModel(session, createMockModel([textStreamParts("success")]));

    const controller = new AbortController();
    await session.send("hi", { signal: controller.signal });

    // Aborting after the send resolved should be a no-op
    controller.abort();

    // No run.cancelled event should fire — the listener was removed
    expect(events.ofType("run.cancelled").length).toBe(0);
  });

  test("abort signal listener is cleaned up after failed send()", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("model exploded");
      },
    });
    patchSessionModel(session, model);

    const controller = new AbortController();
    // The model error propagates through the orchestrator's fallback retry path,
    // ultimately emitting run.failed which rejects the send.
    await expect(session.send("hi", { signal: controller.signal })).rejects.toThrow();

    // Aborting after the failed send should be a no-op — listener was removed by finally handler
    controller.abort();

    // No run.cancelled event should fire
    expect(events.ofType("run.cancelled").length).toBe(0);
  });

  test("session is reusable after abort", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    // First send: blocked and aborted
    const doStreamStarted = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const blockingModel = new MockLanguageModelV4({
      doStream: async () => {
        doStreamStarted.resolve();
        await unblock.promise;

        return { stream: mockStream(textStreamParts("late")) };
      },
    });
    patchSessionModel(session, blockingModel);

    const controller = new AbortController();
    const pending = session.send("first", { signal: controller.signal });
    const caught = pending.catch((err: Error) => err);
    await doStreamStarted.promise;
    controller.abort();
    const rejection = await caught;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Run cancelled");
    unblock.resolve();

    // Second send: fresh working model, no abort signal
    patchSessionModel(session, createMockModel([textStreamParts("recovered")]));
    const result = await session.send("second");

    expect(result.text).toContain("recovered");
  });

  test("aborting after destroy is a no-op", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    const doStreamStarted = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        doStreamStarted.resolve();
        await unblock.promise;

        return { stream: mockStream(textStreamParts("late")) };
      },
    });
    patchSessionModel(session, model);

    const controller = new AbortController();
    const pending = session.send("waiting", { signal: controller.signal });
    const caught = pending.catch((err: Error) => err);
    await doStreamStarted.promise;

    // Destroy rejects the pending send
    session.destroy();
    const rejection = await caught;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Session destroyed");
    session = null;

    // Aborting after destroy should not throw
    controller.abort();

    // Clean up
    unblock.resolve();
  });
});
