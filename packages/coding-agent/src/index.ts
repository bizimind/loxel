export { Session } from "./session/session.ts";
export type {
  SessionConfig,
  SessionEvent as SessionApiEvent,
  SessionEventHandlers,
  SendOptions,
  SendResult,
  MessageContent,
  MessagePart,
  ApprovalDecision as SessionApprovalDecision,
  HumanInputQuestion,
} from "./session/session-types.ts";
export { withAutoApprove, SESSION_EVENT_TYPES } from "./session/event-helpers.ts";

/** Low-level protocol wrapper. Use `Session` for direct programmatic use. */
export { CodingAgentSession } from "./sdk.ts";
export type {
  CodingAgentSessionOptions,
  SessionEventListener,
  SessionErrorListener,
} from "./sdk.ts";

export { CodingAgentRuntime } from "./orchestrator/runtime.ts";
export type { RuntimeDiagnostic, RuntimeDiagnosticListener } from "./orchestrator/runtime.ts";
export { Orchestrator } from "./orchestrator/loop.ts";
export type { LoopControlOptions } from "./orchestrator/loop.ts";
export { ModelRouter } from "./orchestrator/model-router.ts";
export type { ModelConfig, ModelProfile, ModelRouterOptions } from "./orchestrator/model-router.ts";

// Loop control exports
export {
  createLoopDetector,
  MAX_CYCLE_LENGTH,
  MIN_REPETITIONS,
} from "./orchestrator/loop-detector.ts";
export type {
  LoopDetector,
  LoopDetectionResult,
  ToolCallHash,
  ToolCallRecord,
} from "./orchestrator/loop-detector.ts";

export { LoopController, DEFAULT_LOOP_CONTROL_CONFIG } from "./orchestrator/loop-control.ts";
export type { LoopControlConfig, LoopControlAction } from "./orchestrator/loop-control.ts";

export { judgeProgress, LoopJudgmentSchema } from "./orchestrator/loop-judge.ts";
export type { LoopJudgment, JudgeContext, ToolCallSummary } from "./orchestrator/loop-judge.ts";

export {
  verifyConditions,
  identifyConditions,
  formatUnmetConditions,
} from "./orchestrator/completion-conditions.ts";
export type {
  CompletionCondition,
  ConditionResult,
  VerificationResult,
  VerificationContext,
  TaskStatus,
} from "./orchestrator/completion-conditions.ts";

export { CodingAgentError, LoopControlBreakError } from "./core/errors.ts";

export { SessionStore } from "./session/store.ts";
export { planStepSchema, todoItemSchema } from "./session/model.ts";
export type {
  SessionRecord,
  SessionMessage,
  SessionMode,
  SessionEvent,
  SessionCompaction,
  PlanState,
  PlanStep,
  TodoItem,
} from "./session/model.ts";

export { createAiToolSet } from "./tools/registry.ts";
export { invokeToolByName } from "./tools/handlers.ts";
export { toolSchemas } from "./tools/schemas.ts";
export type { ToolProfile } from "./tools/profile.ts";
export type { CanonicalToolName } from "./tools/tool-names.ts";
export { CANONICAL_TOOLS, TOOL_ALIASES, normalizeToolName } from "./tools/tool-names.ts";
export {
  DOCUMENTED_TOOLS,
  LATENT_TOOLS,
  normalizeDeclaredTools,
  intersectWithDeclared,
} from "./tools/capabilities.ts";

export { protocolRequestSchema, protocolEventSchema } from "./protocol/schemas.ts";
export type { ProtocolRequest, ProtocolEvent } from "./protocol/schemas.ts";

export { PermissionStore } from "./permissions/store.ts";
export type { ApprovalDecision, PermissionRule } from "./permissions/model.ts";
export { redactSecrets } from "./utils/redaction.ts";
