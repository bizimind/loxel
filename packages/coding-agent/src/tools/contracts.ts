import type { ZodType } from "zod";

import type { ToolError } from "../core/errors.ts";
import type { SessionRecord } from "../session/model.ts";
import type { ToolProfile } from "./profile.ts";
import type { CanonicalToolName } from "./tool-names.ts";

export interface ToolSuccess<T> {
  ok: true;
  value: T;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export type ToolExecutionMode = "sync" | "streaming" | "long-running";

export interface ToolExecutionContext {
  workspaceRoot: string;
  session: SessionRecord;
  profile: ToolProfile;
  runId: string;
  now: Date;
}

export interface RuntimeToolDefinition<Input, Output> {
  name: CanonicalToolName;
  description: string;
  inputSchema: ZodType<Input>;
  outputSchema: ZodType<Output>;
  requiresApproval: boolean;
  executionMode: ToolExecutionMode;
  execute: (input: Input, ctx: ToolExecutionContext) => Promise<ToolResult<Output>>;
}
