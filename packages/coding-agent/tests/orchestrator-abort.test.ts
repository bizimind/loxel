import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MockLanguageModelV4 } from "ai/test";

import { Orchestrator, type OrchestratorCallbacks } from "../src/orchestrator/loop.ts";
import { ModelRouter } from "../src/orchestrator/model-router.ts";
import type { ProtocolEvent } from "../src/protocol/schemas.ts";
import { SessionStore } from "../src/session/store.ts";
import {
  type TestEnv,
  mockStream,
  patchModelRouter,
  path,
  setupTestEnv,
  textStreamParts,
  toolCallStreamParts,
} from "./helpers/mock-session.ts";

/**
 * Drives `Orchestrator.runTurn` directly, the way an external in-process host would, to make
 * sure cancellation works through the run's `abortSignal` alone, without `CodingAgentRuntime`
 * sitting in between.
 */
describe("Orchestrator abort signal", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupTestEnv("orchestrator-abort");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("aborting the run signal stops the stream before later tool execution", async () => {
    const lateWritePath = path.join(env.workspaceRoot, "late-write.txt");
    const unblockAfterAbort = Promise.withResolvers<void>();
    const textParts = textStreamParts("working");
    const streamParts = [
      ...textParts.slice(0, 3),
      textParts[3]!,
      ...toolCallStreamParts("Write", {
        file_path: lateWritePath,
        content: "must not be written",
      }).slice(1),
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
              const part = streamParts[partIndex];
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

    const sessionStore = new SessionStore();
    const modelRouter = new ModelRouter({ base: { modelId: "mock", apiKey: "test" } });
    patchModelRouter(modelRouter, model);

    const events: ProtocolEvent[] = [];
    const firstDelta = Promise.withResolvers<void>();
    const callbacks: OrchestratorCallbacks = {
      emitEvent: async (event) => {
        events.push(event);
        if (event.type === "run.delta") {
          firstDelta.resolve();
        }
      },
      onHumanQuestion: async () => {
        throw new Error("unexpected question");
      },
      onApproval: async () => "allow",
    };
    const orchestrator = new Orchestrator(sessionStore, modelRouter, callbacks);
    const session = await sessionStore.createSession({ workspaceRoot: env.workspaceRoot });

    const controller = new AbortController();
    const cancellation = new Error("host cancelled the run");
    const pending = orchestrator.runTurn({
      sessionId: session.id,
      messages: [{ role: "user", content: "hello" }],
      abortSignal: controller.signal,
      approvalOverrides: { Write: "allow" },
    });
    const caught = pending.then(
      () => null,
      (error: unknown) => error,
    );

    await firstDelta.promise;
    controller.abort(cancellation);

    expect(await caught).toBe(cancellation);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.call.requested")).toBe(false);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    expect(await Bun.file(lateWritePath).exists()).toBe(false);
  });

  test("an already-aborted signal rejects before the model is called", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: mockStream(textStreamParts("never")) }),
    });
    const sessionStore = new SessionStore();
    const modelRouter = new ModelRouter({ base: { modelId: "mock", apiKey: "test" } });
    patchModelRouter(modelRouter, model);
    const orchestrator = new Orchestrator(sessionStore, modelRouter, {
      emitEvent: async () => {},
      onHumanQuestion: async () => {
        throw new Error("unexpected question");
      },
      onApproval: async () => "deny",
    });
    const session = await sessionStore.createSession({ workspaceRoot: env.workspaceRoot });

    const cancellation = new Error("cancelled before dispatch");
    await expect(
      orchestrator.runTurn({
        sessionId: session.id,
        messages: [{ role: "user", content: "hello" }],
        abortSignal: AbortSignal.abort(cancellation),
      }),
    ).rejects.toBe(cancellation);
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
