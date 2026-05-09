/**
 * Public types for the Session API.
 *
 * The SessionEvent discriminated union and SessionEventHandlers Record
 * ensure exhaustive event handling — callers must acknowledge every event
 * type with a handler or explicit null.
 */
import type { AppLogger } from "@bizimind/logger";

import type { ModelRouterOptions } from "../orchestrator/model-router.ts";
import type { RuntimeDiagnostic } from "../orchestrator/runtime.ts";
import type { PlanStep, TodoItem } from "../session/model.ts";
import type { ToolProfile } from "../tools/profile.ts";

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

export interface SessionConfig {
  workspaceRoot: string;
  models?: ModelRouterOptions;
  logger?: AppLogger;
  /** Environment variables for subprocess spawns (grep, bash). When undefined, inherits process.env. */
  env?: Record<string, string | undefined>;
  mode?: "execute" | "plan";
  profile?: ToolProfile;
  promptProfile?: string;
  declaredTools?: string[];

  /** Required: a handler (or explicit null) for every event type. */
  handlers: SessionEventHandlers;
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type MessageContent = string | MessagePart[];

export interface MessagePart {
  type: "text" | "image";
  text?: string;
  /** Base64-encoded image data. */
  data?: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Send options and result
// ---------------------------------------------------------------------------

export interface SendOptions {
  /** Abort signal for cancellation/steering. */
  signal?: AbortSignal;
  modelProfile?: "planner" | "executor" | "fallback";
  approvalOverrides?: Record<string, "allow" | "deny">;
}

export interface SendResult {
  /** The user message ID in the session store. */
  messageId: string;
  /** The run ID for this execution. */
  runId: string;
  /** The final assistant response text. */
  text: string;
}

// ---------------------------------------------------------------------------
// Session events — discriminated union
// ---------------------------------------------------------------------------

export type ApprovalDecision = "allow" | "allow_this_session" | "allow_always" | "deny";

export interface HumanInputQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

export type SessionEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "session.resumed"; sessionId: string }
  | { type: "run.started"; runId: string }
  | { type: "run.delta"; text: string }
  | { type: "run.reasoning"; text: string }
  | { type: "run.completed"; runId: string; text: string }
  | { type: "run.failed"; runId: string; message: string }
  | { type: "run.cancelled"; runId: string }
  | { type: "tool.call.requested"; toolName: string; toolCallId: string; input: unknown }
  | {
      type: "tool.call.result";
      toolName: string;
      toolCallId: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: "approval.requested";
      key: string;
      toolName: string;
      input: unknown;
      reason: string;
      respond: (decision: ApprovalDecision) => void;
    }
  | {
      type: "human.input.requested";
      key: string;
      questions: HumanInputQuestion[];
      respond: (answers: Record<string, string[]>, freeform?: Record<string, string>) => void;
    }
  | {
      type: "message.received";
      clientMessageId: string | null;
      serverMessageId: string;
      role: string;
      parentMessageId: string | null;
    }
  | { type: "session.rewound"; messageId: string; branchId: string }
  | { type: "plan.mode.entered"; planFilePath: string | null }
  | { type: "plan.mode.exited"; planFilePath: string | null; approved: boolean }
  | { type: "plan.updated"; planFilePath: string | null; steps: PlanStep[] }
  | { type: "plan.step.changed"; stepId: string; from: string; to: string }
  | { type: "plan.completed"; planFilePath: string | null; stepCount: number }
  | { type: "todo.updated"; todos: TodoItem[] }
  | { type: "session.got"; session: Record<string, unknown> }
  | { type: "error"; diagnostic: RuntimeDiagnostic };

// ---------------------------------------------------------------------------
// Exhaustive event handlers Record
// ---------------------------------------------------------------------------

/**
 * A handler (or explicit null) for every session event type.
 * TypeScript enforces all keys are present — you can't forget any event type.
 * Use `null` to acknowledge an event without handling it.
 */
export type SessionEventHandlers = {
  [E in SessionEvent["type"]]: ((event: Extract<SessionEvent, { type: E }>) => void) | null;
};
