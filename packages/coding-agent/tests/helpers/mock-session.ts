/**
 * Shared test helpers for Session API tests.
 *
 * Provides mock model builders, event collectors, and environment setup
 * so that each topic-specific test file stays focused on its scenarios.
 */
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { SessionEvent, SessionEventHandlers } from "../../src/session/session-types.ts";

import { Session } from "../../src/session/session.ts";

// The real stream-part type from the V3 spec (extracted structurally so we
// don't add a dep on @ai-sdk/provider).
type DoStreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type LanguageModelStreamPart = DoStreamResult["stream"] extends ReadableStream<infer P> ? P : never;

// ---------------------------------------------------------------------------
// Stream part helpers
// ---------------------------------------------------------------------------

const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

/** Build stream parts for a text-only model response (finishReason: "stop"). */
export function textStreamParts(text: string) {
  const id = `t-${crypto.randomUUID().slice(0, 8)}`;
  return [
    { type: "stream-start" as const, warnings: [] as never[] },
    { type: "text-start" as const, id },
    { type: "text-delta" as const, id, delta: text },
    { type: "text-end" as const, id },
    { type: "finish" as const, usage: MOCK_USAGE, finishReason: "stop" as const },
  ];
}

/** Build stream parts for a tool call (finishReason: "tool-calls"). */
export function toolCallStreamParts(toolName: string, input: Record<string, unknown>) {
  const id = `tc-${crypto.randomUUID().slice(0, 8)}`;
  return [
    { type: "stream-start" as const, warnings: [] as never[] },
    { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish" as const, usage: MOCK_USAGE, finishReason: "tool-calls" as const },
  ];
}

// ---------------------------------------------------------------------------
// Mock model builder
// ---------------------------------------------------------------------------

// Mock stream parts are loosely shaped — the helpers below omit fields that
// the real V3 type requires. We derive StreamPart from the helper returns and
// cast once at the MockLanguageModelV3 boundary where the full shape is needed.
type StreamPart =
  | ReturnType<typeof textStreamParts>[number]
  | ReturnType<typeof toolCallStreamParts>[number];
type StreamParts = StreamPart[];

/**
 * Convert mock stream parts to the ReadableStream shape MockLanguageModelV3
 * expects. Centralizes the one cast needed because our mock parts omit fields
 * required by the full LanguageModelV3StreamPart type.
 */
export function mockStream(parts: StreamParts): ReadableStream<LanguageModelStreamPart> {
  return convertArrayToReadableStream(parts as unknown as LanguageModelStreamPart[]);
}

/**
 * Create a MockLanguageModelV3 that pops responses from a queue.
 * Each entry in `responses` is consumed on a successive `doStream` call
 * (one per model step in the `streamText` loop).
 */
export function createMockModel(responses: StreamParts[]) {
  const queue = [...responses];
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = queue.shift();
      if (!parts) throw new Error("Mock model: no more responses queued");
      return { stream: mockStream(parts) };
    },
  });
}

// ---------------------------------------------------------------------------
// Patch session model
// ---------------------------------------------------------------------------

/** Replace the model router on a Session's internal runtime with a mock model. */
export function patchSessionModel(session: Session, model: MockLanguageModelV3): void {
  // Structurally typed access to private runtime for testing — narrow to the
  // single field we patch rather than using `any`.
  const internals = session as unknown as {
    runtime: { modelRouter: { getModel: () => MockLanguageModelV3 } };
  };
  internals.runtime.modelRouter.getModel = () => model;
}

// ---------------------------------------------------------------------------
// Event collector
// ---------------------------------------------------------------------------

export interface EventCollector {
  handlers: SessionEventHandlers;
  all: SessionEvent[];
  ofType: <T extends SessionEvent["type"]>(type: T) => Extract<SessionEvent, { type: T }>[];
  /** Returns a promise that resolves when an event of the given type is observed. */
  waitFor: <T extends SessionEvent["type"]>(type: T) => Promise<Extract<SessionEvent, { type: T }>>;
}

/**
 * Build an EventCollector that captures all session events.
 *
 * Default behavior:
 * - `approval.requested` auto-responds with "allow" (deferred via setTimeout)
 * - `human.input.requested` auto-responds with empty answers (deferred)
 *
 * Pass `overrides` to replace handlers for specific event types.
 *
 * **Important**: approval and human-input `respond()` calls MUST be deferred
 * via `setTimeout(fn, 50)` so the runtime registers the pending entry before
 * the response arrives. See the runtime's emit → sink → handler synchronous
 * path and the async disk persistence in `emitFull`.
 */
export function collectEvents(overrides?: Partial<SessionEventHandlers>): EventCollector {
  const all: SessionEvent[] = [];
  const waiters: Array<{ type: string; resolve: (event: SessionEvent) => void }> = [];

  const push = (e: SessionEvent) => {
    all.push(e);
    // Notify any pending waitFor() calls
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.type === e.type) {
        waiters[i]!.resolve(e);
        waiters.splice(i, 1);
      }
    }
  };

  const handlers: SessionEventHandlers = {
    "session.started": push,
    "session.resumed": push,
    "run.started": push,
    "run.delta": push,
    "run.reasoning": push,
    "run.completed": push,
    "run.failed": push,
    "run.cancelled": push,
    "tool.call.requested": push,
    "tool.call.result": push,
    "approval.requested": (e) => {
      push(e);
      setTimeout(() => e.respond("allow"), 50);
    },
    "human.input.requested": (e) => {
      push(e);
      setTimeout(() => e.respond({}), 50);
    },
    "message.received": push,
    "session.rewound": push,
    "plan.mode.entered": push,
    "plan.mode.exited": push,
    "plan.updated": push,
    "plan.step.changed": push,
    "plan.completed": push,
    "todo.updated": push,
    "session.got": push,
    error: push,
    ...overrides,
  };

  return {
    handlers,
    all,
    ofType: <T extends SessionEvent["type"]>(type: T) =>
      all.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type),
    waitFor: <T extends SessionEvent["type"]>(type: T) =>
      new Promise<Extract<SessionEvent, { type: T }>>((resolve) => {
        // Check if already received
        const existing = all.find((e) => e.type === type);
        if (existing) {
          resolve(existing as Extract<SessionEvent, { type: T }>);
          return;
        }
        waiters.push({ type, resolve: resolve as (event: SessionEvent) => void });
      }),
  };
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

const originalHome = process.env.HOME;
const originalStateRoot = process.env.CODING_AGENT_STATE_ROOT;

function testId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TestEnv {
  testHome: string;
  workspaceRoot: string;
  /** Call in afterEach to clean up temp dirs and restore env vars. */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test environment with unique temp dirs.
 * Sets HOME and CODING_AGENT_STATE_ROOT env vars.
 *
 * @param prefix - short label for the test file (e.g. "lifecycle", "tools")
 */
export async function setupTestEnv(prefix: string): Promise<TestEnv> {
  const id = testId();
  const testHome = path.join(process.cwd(), "tmp-test-home", `${prefix}-${id}`);
  const workspaceRoot = path.join(process.cwd(), "tmp-test-workspace", `${prefix}-${id}`);
  process.env.HOME = testHome;
  process.env.CODING_AGENT_STATE_ROOT = path.join(
    testHome,
    ".local",
    "state",
    "loxel",
    "coding-agent",
  );
  await mkdir(workspaceRoot, { recursive: true });

  return {
    testHome,
    workspaceRoot,
    cleanup: async () => {
      await rm(testHome, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(path.join(process.cwd(), "tmp-test-home"), { recursive: true, force: true });
      await rm(path.join(process.cwd(), "tmp-test-workspace"), { recursive: true, force: true });
      process.env.HOME = originalHome;
      process.env.CODING_AGENT_STATE_ROOT = originalStateRoot;
    },
  };
}

export { Session, MockLanguageModelV3, path };
export type { SessionEvent, SessionEventHandlers };
