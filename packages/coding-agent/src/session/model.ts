import { z } from "zod";

import type { ToolProfile } from "../tools/profile.ts";

export type SessionMode = "execute" | "plan";

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  rationale?: string;
}

export interface PlanState {
  planFilePath: string | null;
  steps: PlanStep[];
  approved: boolean;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  activeForm: string;
}

export interface ReminderState {
  activeConditions: Record<string, boolean>;
  reminderHistory: Record<string, number>;
  cooldowns: Record<string, number>;
  maxRepeats: Record<string, number>;
  repeats: Record<string, number>;
  conditionPayload: Record<string, Record<string, string>>;
}

export interface AgentControlledState {
  mode: SessionMode;
  profile: ToolProfile;
  plan: PlanState;
  todos: TodoItem[];
  reminders: ReminderState;
}

export interface SessionMessage {
  id: string;
  branchId: string;
  parentMessageId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  createdAt: string;
  runId: string | null;
}

export interface SessionBranch {
  id: string;
  parentBranchId: string | null;
  forkedFromMessageId: string | null;
  createdAt: string;
  label: string;
}

export interface SessionCompaction {
  id: string;
  sourceMessageIds: string[];
  summary: string;
  files: string[];
  planSnapshot: string | null;
  promptProfile: string;
  createdAt: string;
  replacementMessageId: string;
}

export interface SessionLineage {
  parentSessionId: string | null;
  forkPointMessageId: string | null;
}

export interface SessionSubagent {
  id: string;
  parentAgentId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  description: string | null;
  subagentType: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  resumedFromTaskId: string | null;
}

export interface SessionApprovalDecision {
  id: string;
  timestamp: string;
  toolName: string;
  decision: "allow" | "allow_this_session" | "allow_always" | "deny";
  input: unknown;
}

export interface SessionRecord {
  id: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  activeBranchId: string;
  activeMessageId: string | null;
  branches: Record<string, SessionBranch>;
  branchHeads: Record<string, string | null>;
  messages: Record<string, SessionMessage>;
  snapshots: Record<string, AgentControlledState>;
  state: AgentControlledState;
  compactions: SessionCompaction[];
  approvals: SessionApprovalDecision[];
  contextReplacementMessageId: string | null;
  promptProfile: string;
  declaredTools: string[] | null;
  lineage: SessionLineage;
  subagents: Record<string, SessionSubagent>;
}

export interface SessionEventScope {
  agentId: string;
  parentAgentId: string | null;
  kind: "main" | "subagent";
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
  runId?: string;
  scope?: SessionEventScope;
}

const sessionModeSchema = z.enum(["execute", "plan"]);

export const planStepSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    rationale: z.string().optional(),
  })
  .strict();

const planStateSchema = z
  .object({
    planFilePath: z.string().nullable(),
    steps: z.array(planStepSchema),
    approved: z.boolean(),
  })
  .strict();

export const todoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    activeForm: z.string(),
  })
  .strict();

const reminderStateSchema = z
  .object({
    activeConditions: z.record(z.string(), z.boolean()),
    reminderHistory: z.record(z.string(), z.number().int()),
    cooldowns: z.record(z.string(), z.number().int()),
    maxRepeats: z.record(z.string(), z.number().int()),
    repeats: z.record(z.string(), z.number().int()),
    conditionPayload: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .strict();

export const agentControlledStateSchema = z
  .object({
    mode: sessionModeSchema,
    profile: z.enum(["execute", "plan", "minimal"]),
    plan: planStateSchema,
    todos: z.array(todoItemSchema),
    reminders: reminderStateSchema,
  })
  .strict();

export const sessionMessageSchema = z
  .object({
    id: z.string(),
    branchId: z.string(),
    parentMessageId: z.string().nullable(),
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.unknown(),
    createdAt: z.string(),
    runId: z.string().nullable(),
  })
  .strict();

export const sessionBranchSchema = z
  .object({
    id: z.string(),
    parentBranchId: z.string().nullable(),
    forkedFromMessageId: z.string().nullable(),
    createdAt: z.string(),
    label: z.string(),
  })
  .strict();

const sessionCompactionSchema = z
  .object({
    id: z.string(),
    sourceMessageIds: z.array(z.string()),
    summary: z.string(),
    files: z.array(z.string()),
    planSnapshot: z.string().nullable(),
    promptProfile: z.string(),
    createdAt: z.string(),
    replacementMessageId: z.string(),
  })
  .strict();

const sessionLineageSchema = z
  .object({ parentSessionId: z.string().nullable(), forkPointMessageId: z.string().nullable() })
  .strict();

const sessionSubagentSchema = z
  .object({
    id: z.string(),
    parentAgentId: z.string().nullable(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    description: z.string().nullable(),
    subagentType: z.string().nullable(),
    model: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    resumedFromTaskId: z.string().nullable(),
  })
  .strict();

const sessionApprovalDecisionSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    toolName: z.string(),
    decision: z.enum(["allow", "allow_this_session", "allow_always", "deny"]),
    input: z.unknown(),
  })
  .strict();

export const sessionRecordSchema = z
  .object({
    id: z.string(),
    workspaceRoot: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    activeBranchId: z.string(),
    activeMessageId: z.string().nullable(),
    branches: z.record(z.string(), sessionBranchSchema),
    branchHeads: z.record(z.string(), z.string().nullable()),
    messages: z.record(z.string(), sessionMessageSchema),
    snapshots: z.record(z.string(), agentControlledStateSchema),
    state: agentControlledStateSchema,
    compactions: z.array(sessionCompactionSchema),
    approvals: z.array(sessionApprovalDecisionSchema).default([]),
    contextReplacementMessageId: z.string().nullable(),
    promptProfile: z.string(),
    declaredTools: z.array(z.string()).nullable().default(null),
    lineage: sessionLineageSchema,
    subagents: z.record(z.string(), sessionSubagentSchema).default({}),
  })
  .strict();

const sessionEventScopeSchema = z
  .object({
    agentId: z.string(),
    parentAgentId: z.string().nullable(),
    kind: z.enum(["main", "subagent"]),
  })
  .strict();

export const sessionEventSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    timestamp: z.string(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
    requestId: z.string().optional(),
    runId: z.string().optional(),
    scope: sessionEventScopeSchema.optional(),
  })
  .strict();

export function createDefaultReminderState(): ReminderState {
  return {
    activeConditions: {},
    reminderHistory: {},
    cooldowns: {},
    maxRepeats: {},
    repeats: {},
    conditionPayload: {},
  };
}
