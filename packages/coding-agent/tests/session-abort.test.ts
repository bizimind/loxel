import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MockLanguageModelV4 } from "ai/test";

import {
  type TestEnv,
  Session,
  collectEvents,
  createMockModel,
  mockStream,
  patchSessionModel,
  path,
  setupTestEnv,
  textStreamParts,
  toolCallStreamParts,
} from "./helpers/mock-session.ts";

function activeRunCount(activeSession: Session): number {
  const runtime = (
    activeSession as unknown as { runtime: { activeRunBySession: Map<string, string> } }
  ).runtime;
  return runtime.activeRunBySession.size;
}

async function waitForRuntimeIdle(activeSession: Session): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (activeRunCount(activeSession) === 0) return;
    await Bun.sleep(10);
  }

  throw new Error("Timed out waiting for the cancelled run to stop");
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(filePath).exists()) return;
    await Bun.sleep(10);
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("Expected promise to reject");
}

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

  test("abort immediately after send stops the run before model dispatch", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    const model = createMockModel([textStreamParts("unreachable")]);
    patchSessionModel(session, model);

    const controller = new AbortController();
    const pending = session.send("hi", { signal: controller.signal });
    const caught = captureRejection(pending);

    // The runtime must register the run synchronously, before its first session-store await.
    expect(activeRunCount(session)).toBe(1);
    controller.abort();

    expect((await caught).message).toBe("Run cancelled");
    await waitForRuntimeIdle(session);

    expect(model.doStreamCalls).toHaveLength(0);
    expect(events.ofType("run.cancelled")).toHaveLength(1);
    expect(events.ofType("run.started")).toHaveLength(0);
    expect(events.ofType("run.completed")).toHaveLength(0);
    expect(events.ofType("run.failed")).toHaveLength(0);
  });

  test("abort mid-stream stops generation before later tool execution", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    const lateWritePath = path.join(env.workspaceRoot, "late-write.txt");
    const unblockAfterAbort = Promise.withResolvers<void>();
    const initialTextParts = textStreamParts("working");
    const lateToolParts = toolCallStreamParts("Write", {
      file_path: lateWritePath,
      content: "must not be written",
    });
    const firstStreamParts = [
      ...initialTextParts.slice(0, 3),
      initialTextParts[3]!,
      ...lateToolParts.slice(1),
    ];
    let partIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        if (model.doStreamCalls.length > 1) {
          return { stream: mockStream(textStreamParts("late completion")) };
        }

        abortSignal?.addEventListener("abort", () => unblockAfterAbort.resolve(), { once: true });

        return {
          stream: new ReadableStream({
            async pull(controller) {
              if (partIndex === 3) {
                await unblockAfterAbort.promise;
                if (abortSignal?.aborted) {
                  controller.error(new DOMException("Run cancelled", "AbortError"));
                  return;
                }
              }

              const part = firstStreamParts[partIndex];
              partIndex += 1;
              if (part) {
                controller.enqueue(part);
              } else {
                controller.close();
              }
            },
          }),
        };
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

    // Wait until application code observes a model delta. The provider stream's
    // next pull is blocked, so cancellation must interrupt it before the late tool call.
    await events.waitFor("run.delta");

    controller.abort();
    await caught;
    unblockAfterAbort.resolve();
    await waitForRuntimeIdle(session);

    expect(rejection).not.toBeNull();
    expect(rejection!.message).toBe("Run cancelled");
    expect(events.ofType("run.cancelled")).toHaveLength(1);
    expect(events.ofType("tool.call.requested")).toHaveLength(0);
    expect(events.ofType("run.completed")).toHaveLength(0);
    expect(events.ofType("run.failed")).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await Bun.file(lateWritePath).exists()).toBe(false);
  });

  test("abort stops an in-flight Bash tool", async () => {
    const events = collectEvents();
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });

    const startedPath = path.join(env.workspaceRoot, "bash-started.txt");
    const lateWritePath = path.join(env.workspaceRoot, "bash-late-write.txt");
    const childScript = [
      `await Bun.write(${JSON.stringify(startedPath)}, "started")`,
      "await Bun.sleep(500)",
      `await Bun.write(${JSON.stringify(lateWritePath)}, "late")`,
    ].join("; ");
    // Keep the Bun process as a shell child: killing only the shell would let this child write late.
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`;
    const model = createMockModel([
      toolCallStreamParts("Bash", { command, timeout: 5_000 }),
      textStreamParts("unreachable"),
    ]);
    patchSessionModel(session, model);

    const controller = new AbortController();
    const pending = session.send("run command", {
      signal: controller.signal,
      approvalOverrides: { Bash: "allow" },
    });
    const caught = captureRejection(pending);

    await waitForFile(startedPath);
    controller.abort();

    expect((await caught).message).toBe("Run cancelled");
    await waitForRuntimeIdle(session);
    await Bun.sleep(600);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(await Bun.file(lateWritePath).exists()).toBe(false);
    expect(events.ofType("run.cancelled")).toHaveLength(1);
    expect(events.ofType("run.completed")).toHaveLength(0);
    expect(events.ofType("run.failed")).toHaveLength(0);
  });

  test("abort rejects a pending tool approval", async () => {
    const approvalRequested = Promise.withResolvers<void>();
    const events = collectEvents({ "approval.requested": () => approvalRequested.resolve() });
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    const model = createMockModel([
      toolCallStreamParts("Bash", { command: "echo unreachable" }),
      textStreamParts("unreachable"),
    ]);
    patchSessionModel(session, model);

    const controller = new AbortController();
    const pending = session.send("run command", { signal: controller.signal });
    const caught = captureRejection(pending);

    await approvalRequested.promise;
    controller.abort();

    expect((await caught).message).toBe("Run cancelled");
    await waitForRuntimeIdle(session);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(events.ofType("run.cancelled")).toHaveLength(1);
    expect(events.ofType("run.completed")).toHaveLength(0);
    expect(events.ofType("run.failed")).toHaveLength(0);
  });

  test("abort rejects a pending human question", async () => {
    const questionRequested = Promise.withResolvers<void>();
    const events = collectEvents({ "human.input.requested": () => questionRequested.resolve() });
    session = await Session.create({ workspaceRoot: env.workspaceRoot, handlers: events.handlers });
    const model = createMockModel([
      toolCallStreamParts("AskUserQuestion", {
        questions: [
          {
            id: "choice",
            question: "Pick one?",
            header: "Choice",
            options: [
              { label: "A (Recommended)", description: "First choice" },
              { label: "B", description: "Second choice" },
            ],
          },
        ],
      }),
      textStreamParts("unreachable"),
    ]);
    patchSessionModel(session, model);

    const controller = new AbortController();
    const pending = session.send("ask me", { signal: controller.signal });
    const caught = captureRejection(pending);

    await questionRequested.promise;
    controller.abort();

    expect((await caught).message).toBe("Run cancelled");
    await waitForRuntimeIdle(session);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(events.ofType("run.cancelled")).toHaveLength(1);
    expect(events.ofType("run.completed")).toHaveLength(0);
    expect(events.ofType("run.failed")).toHaveLength(0);
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
