import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { ProtocolEvent } from "../src/protocol/schemas.ts";

import { CodingAgentRuntime } from "../src/orchestrator/runtime.ts";
import { SessionStore } from "../src/session/store.ts";
import { createMockModel, textStreamParts } from "./helpers/mock-session.ts";

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;

describe("CodingAgentRuntime events", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = path.join(process.cwd(), "tmp-test-home", `runtime-${Date.now()}`);
    process.env.HOME = testHome;
    process.env.CODING_AGENT_STATE_ROOT = path.join(
      testHome,
      ".local",
      "state",
      "loxel",
      "coding-agent",
    );
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await rm(path.join(process.cwd(), "tmp-test-home"), { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.CODING_AGENT_STATE_ROOT = originalStateRoot;
  });

  test("emits start + resume + compaction events", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_start",
      workspace_root: process.cwd(),
      profile: "execute",
    });

    const started = events.find((event) => event.type === "session.started");
    expect(started).toBeDefined();

    const sessionId = started?.payload.session_id as string;
    expect(typeof sessionId).toBe("string");

    await runtime.handleRequest({
      type: "session.compact",
      request_id: "req_compact",
      session_id: sessionId,
    });

    expect(events.some((event) => event.type === "context.compaction.started")).toBe(true);
    expect(events.some((event) => event.type === "context.compaction.completed")).toBe(true);

    await runtime.handleRequest({
      type: "session.resume",
      request_id: "req_resume",
      session_id: sessionId,
    });

    expect(events.some((event) => event.type === "session.resumed")).toBe(true);
  });

  test("approval.response resolves alias key and emits decision event", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    const resolved: string[] = [];
    (
      runtime as unknown as {
        pendingApprovals: Map<
          string,
          { resolve: (value: "allow" | "allow_this_session" | "allow_always" | "deny") => void }
        >;
      }
    ).pendingApprovals.set("run_1:approval:evt_1", { resolve: (value) => resolved.push(value) });
    (
      runtime as unknown as { pendingApprovalAliases: Map<string, string> }
    ).pendingApprovalAliases.set("run_1:approval:Write", "run_1:approval:evt_1");

    await runtime.handleRequest({
      type: "approval.response",
      request_id: "req_approval",
      session_id: "session_1",
      run_id: "run_1",
      tool_name: "Write",
      decision: "allow_this_session",
    });

    expect(resolved[0]).toBe("allow_this_session");
    expect(events.some((event) => event.type === "approval.granted")).toBe(true);
  });

  test("human.input.response emits protocol event", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    const resolved: unknown[] = [];
    (
      runtime as unknown as { pendingQuestions: Map<string, { resolve: (value: unknown) => void }> }
    ).pendingQuestions.set("run_1:question:evt_1", { resolve: (value) => resolved.push(value) });

    await runtime.handleRequest({
      type: "human.input.response",
      request_id: "req_human",
      session_id: "session_1",
      run_id: "run_1",
      pending_key: "run_1:question:evt_1",
      answers: { q1: ["a"] },
    });

    expect(resolved.length).toBe(1);
    expect(events.some((event) => event.type === "human.input.response")).toBe(true);
  });

  test("session.start in plan mode emits plan-mode context", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_plan_start",
      workspace_root: process.cwd(),
      profile: "plan",
      mode: "plan",
    });

    const started = events.find((event) => event.type === "session.started");
    expect(typeof started?.payload.plan_file_path).toBe("string");
    expect(events.some((event) => event.type === "plan.mode.entered")).toBe(true);
  });

  test("session.start includes declared_tools in emitted payload", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_declared",
      workspace_root: process.cwd(),
      profile: "execute",
      declared_tools: ["Read", "ToolSearch"],
    });

    const started = events.find((event) => event.type === "session.started");
    expect(started?.payload.declared_tools).toEqual(["Read", "ToolSearch"]);
  });

  test("preserves system message order and uses AI SDK 7 usage metadata", async () => {
    const events: ProtocolEvent[] = [];
    const runCompleted = Promise.withResolvers<void>();
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
        if (event.type === "run.completed") {
          runCompleted.resolve();
        } else if (event.type === "run.failed") {
          runCompleted.reject(new Error(String(event.payload.message)));
        }
      },
    });
    const model = createMockModel([textStreamParts("done")]);
    const internals = runtime as unknown as { modelRouter: { getModel: () => typeof model } };
    internals.modelRouter.getModel = () => model;

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_system_start",
      workspace_root: process.cwd(),
      profile: "execute",
      messages: [
        { role: "user", content: "earlier user message" },
        { role: "system", content: "Persisted system instruction" },
      ],
    });
    const sessionId = events.find((event) => event.type === "session.started")?.payload
      .session_id as string;

    await runtime.handleRequest({
      type: "session.input",
      request_id: "req_system_input",
      session_id: sessionId,
      messages: [{ role: "user", content: "hello" }],
    });
    await runCompleted.promise;

    const providerPrompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(providerPrompt.map((message) => message.role)).toEqual([
      "system",
      "user",
      "system",
      "user",
    ]);
    expect(providerPrompt[2]?.content).toBe("Persisted system instruction");

    const stepCompleted = events.find((event) => event.type === "run.step.model.completed");
    expect(stepCompleted?.payload.finish_reason).toBe("stop");
    expect(stepCompleted?.payload.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
    });
    runtime.destroy();
  });

  test("persists relevant protocol events into session event log", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_persist_protocol",
      workspace_root: process.cwd(),
      profile: "execute",
    });

    const sessionId = events.find((event) => event.type === "session.started")?.payload
      .session_id as string;
    const store = new SessionStore();
    const persisted = await store.readEvents(sessionId);
    expect(
      persisted.some(
        (event) =>
          event.type === "protocol.event" &&
          event.payload.event_type === "session.started" &&
          event.requestId === "req_persist_protocol",
      ),
    ).toBe(true);
  });

  test("supports session list/get protocol requests", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_start_for_list",
      workspace_root: process.cwd(),
      profile: "execute",
    });
    const sessionId = events.find((event) => event.type === "session.started")?.payload
      .session_id as string;

    await runtime.handleRequest({ type: "session.list", request_id: "req_list" });
    await runtime.handleRequest({
      type: "session.get",
      request_id: "req_get",
      session_id: sessionId,
    });

    expect(events.some((event) => event.type === "session.listed")).toBe(true);
    expect(events.some((event) => event.type === "session.got")).toBe(true);
  });

  test("emits runtime.error and invokes listeners when protocol-event persistence fails", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    const diagnostics: Array<{ code: string; message: string }> = [];
    runtime.on("error", (diagnostic) => {
      diagnostics.push({ code: diagnostic.code, message: diagnostic.message });
    });

    const runtimeWithStore = runtime as unknown as {
      sessionStore: {
        appendEvent: (
          sessionId: string,
          type: string,
          payload: Record<string, unknown>,
          options?: {
            requestId?: string;
            runId?: string;
            scope?: { agentId: string; parentAgentId: string | null; kind: "main" | "subagent" };
          },
        ) => Promise<unknown>;
      };
    };

    const originalAppendEvent = runtimeWithStore.sessionStore.appendEvent.bind(
      runtimeWithStore.sessionStore,
    );
    runtimeWithStore.sessionStore.appendEvent = async (sessionId, type, payload, options) => {
      if (type === "protocol.event") {
        throw new Error("disk write failed");
      }
      return originalAppendEvent(sessionId, type, payload, options);
    };

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_runtime_error",
      workspace_root: process.cwd(),
      profile: "execute",
    });

    expect(events.some((event) => event.type === "runtime.error")).toBe(true);
    expect(diagnostics.some((diag) => diag.code === "PROTOCOL_EVENT_PERSIST_FAILED")).toBe(true);
  });

  test("session.resume loads replayed session state", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    await runtime.handleRequest({
      type: "session.start",
      request_id: "req_start_replay",
      workspace_root: process.cwd(),
      profile: "execute",
      messages: [{ role: "user", content: "hello" }],
    });
    const sessionId = events.find((event) => event.type === "session.started")?.payload
      .session_id as string;

    await runtime.handleRequest({
      type: "session.resume",
      request_id: "req_resume_replay",
      session_id: sessionId,
    });

    const resumed = events.find((event) => event.type === "session.resumed");
    expect(resumed?.payload.replayed_from_events).toBe(true);
  });

  test("emitted events are redacted", async () => {
    const events: ProtocolEvent[] = [];
    const runtime = new CodingAgentRuntime({
      emit: async (event) => {
        events.push(event);
      },
    });

    (
      runtime as unknown as { pendingQuestions: Map<string, { resolve: (value: unknown) => void }> }
    ).pendingQuestions.set("run_1:question:evt_1", { resolve: () => {} });
    await runtime.handleRequest({
      type: "human.input.response",
      request_id: "req_redact",
      session_id: "session_1",
      run_id: "run_1",
      pending_key: "run_1:question:evt_1",
      answers: { q1: ["a"] },
      freeform: { q1: "token sk-or-v1-abcdefghijklmnop" },
    });

    const text = JSON.stringify(events);
    expect(text.includes("sk-or-v1-abcdefghijklmnop")).toBe(false);
    expect(text.includes("[REDACTED]")).toBe(true);
  });
});
