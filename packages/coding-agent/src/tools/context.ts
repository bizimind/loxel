import type { ModelConfig } from "../orchestrator/model-router.ts";
import type { PermissionStore } from "../permissions/store.ts";
import type { SessionRecord } from "../session/model.ts";
import type { SessionStore } from "../session/store.ts";
import type { ToolProfile } from "./profile.ts";
import type { TaskManager } from "./task-manager.ts";
import type { CanonicalToolName } from "./tool-names.ts";

export interface HumanQuestionRequest {
  runId: string;
  sessionId: string;
  toolName: "AskUserQuestion";
  input: unknown;
}

export interface ApprovalRequest {
  runId: string;
  sessionId: string;
  toolName: CanonicalToolName;
  input: unknown;
  reason: string;
}

export type HumanQuestionHandler = (req: HumanQuestionRequest) => Promise<unknown>;
export type ApprovalHandler = (
  req: ApprovalRequest,
) => Promise<"allow" | "allow_this_session" | "allow_always" | "deny">;

export interface ToolRuntimeContext {
  workspaceRoot: string;
  session: SessionRecord;
  sessionStore: SessionStore;
  permissionStore: PermissionStore;
  taskManager: TaskManager;
  profile: ToolProfile;
  runId: string;
  declaredTools?: CanonicalToolName[];
  approvalOverrides?: Partial<Record<CanonicalToolName, "allow" | "deny">>;
  providerConfig?: { webSearch?: ModelConfig; webSearchFallback?: ModelConfig };
  /** Environment variables passed to spawned subprocesses. When undefined, inherits process.env. */
  env?: Record<string, string | undefined>;
  emitEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
  onHumanQuestion: HumanQuestionHandler;
  onApproval: ApprovalHandler;
}
