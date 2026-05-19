import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { ToolRuntimeContext } from "./context.ts";
import type { ToolResult } from "./contracts.ts";

import {
  BASH_LIMITS,
  GLOB_LIMITS,
  GREP_LIMITS,
  READ_LIMITS,
  WEB_LIMITS,
} from "../core/constants.ts";
import { toToolError } from "../core/errors.ts";
import { activateReminder, clearReminder } from "../prompts/reminders.ts";
import { ensureStateLayout, getSessionPaths, getStateLayout } from "../state/layout.ts";
import { createPlanFileName } from "../utils/ids.ts";
import { isPathWithinResolved, normalizeWorkspacePath } from "../utils/path.ts";
import { resolveShellBinary } from "../utils/shell.ts";
import { isToolAllowedInProfile } from "./profile.ts";
import {
  askUserQuestionInputSchema,
  askUserQuestionOutputSchema,
  bashInputSchema,
  bashOutputSchema,
  editInputSchema,
  editOutputSchema,
  enterPlanModeInputSchema,
  enterPlanModeOutputSchema,
  exitPlanModeInputSchema,
  exitPlanModeOutputSchema,
  globInputSchema,
  globOutputSchema,
  grepInputSchema,
  grepOutputSchema,
  multiEditInputSchema,
  multiEditOutputSchema,
  readInputSchema,
  readOutputSchema,
  skillInputSchema,
  skillOutputSchema,
  taskInputSchema,
  taskOutputInputSchema,
  taskOutputOutputSchema,
  taskOutputSchema,
  taskStopInputSchema,
  taskStopOutputSchema,
  todoReadInputSchema,
  todoReadOutputSchema,
  todoWriteInputSchema,
  todoWriteOutputSchema,
  toolSchemas,
  toolSearchInputSchema,
  toolSearchOutputSchema,
  webFetchInputSchema,
  webFetchOutputSchema,
  webSearchInputSchema,
  webSearchOutputSchema,
  writeInputSchema,
  writeOutputSchema,
  type AskUserQuestionOutput,
  type BashOutput,
  type EditOutput,
  type EnterPlanModeOutput,
  type ExitPlanModeOutput,
  type GlobOutput,
  type GrepOutput,
  type MultiEditOutput,
  type ReadOutput,
  type SkillOutput,
  type TaskOutput,
  type TaskOutputOutput,
  type TaskStopOutput,
  type TodoReadOutput,
  type TodoWriteOutput,
  type ToolSearchOutput,
  type WebFetchOutput,
  type WebSearchOutput,
  type WriteOutput,
} from "./schemas.ts";
import { CANONICAL_TOOLS, normalizeToolName, type CanonicalToolName } from "./tool-names.ts";

interface RuntimeTool {
  name: CanonicalToolName;
  description: string;
  requiresApproval: boolean;
  execute: (input: unknown, ctx: ToolRuntimeContext) => Promise<ToolResult<unknown>>;
}

function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}

function err(
  code: Parameters<typeof toToolError>[0],
  message: string,
  retriable: boolean,
  suggestedFix: string,
): ToolResult<never> {
  return { ok: false, error: toToolError(code, message, retriable, suggestedFix) };
}

function parseWithSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
):
  | { success: true; data: z.infer<TSchema> }
  | { success: false; unknownField: boolean; message: string } {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const unknownField = result.error.issues.some((issue) => issue.code === "unrecognized_keys");
  const message = result.error.issues.map((issue) => issue.message).join("; ");
  return { success: false, unknownField, message: message || "Invalid tool input" };
}

function parsePlanSteps(
  content: string,
): Array<{
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}> {
  const lines = content.split("\n");
  const steps: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "blocked";
  }> = [];

  let seenInProgress = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    const match = line.match(/^-\s\[( |x|>|!)\]\s(.+)$/i);
    if (!match) {
      continue;
    }

    const marker = match[1]?.toLowerCase();
    const parsedStatus =
      marker === "x"
        ? "completed"
        : marker === ">"
          ? "in_progress"
          : marker === "!"
            ? "blocked"
            : "pending";
    const status = parsedStatus === "in_progress" && seenInProgress ? "pending" : parsedStatus;
    if (status === "in_progress") {
      seenInProgress = true;
    }
    steps.push({ id: `plan_step_${i + 1}`, title: match[2]?.trim() ?? "", status });
  }

  return steps;
}

function truncateByLinesAndBytes(text: string): { preview: string; truncated: boolean } {
  const lines = text.split("\n");
  const limitedLines = lines.slice(0, BASH_LIMITS.maxPreviewLines);
  let preview = limitedLines.join("\n");

  if (Buffer.byteLength(preview, "utf8") > BASH_LIMITS.maxPreviewBytes) {
    preview = preview.slice(0, BASH_LIMITS.maxPreviewBytes);
  }

  const truncated =
    limitedLines.length < lines.length ||
    Buffer.byteLength(text, "utf8") > BASH_LIMITS.maxPreviewBytes;

  return { preview, truncated };
}

function normalizeRecencyQuery(query: string): string {
  const lower = query.toLowerCase();
  const hasRecencyCue = ["latest", "recent", "current", "today"].some((cue) => lower.includes(cue));
  if (!hasRecencyCue) {
    return query;
  }
  const currentYear = String(new Date().getFullYear());
  if (query.includes(currentYear)) {
    return query;
  }
  return `${query} ${currentYear}`;
}

function matchesDomainFilters(
  candidateUrl: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
): boolean {
  let host: string;
  try {
    host = new URL(candidateUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (allowedDomains?.length) {
    const allowed = allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!allowed) {
      return false;
    }
  }

  if (blockedDomains?.length) {
    const blocked = blockedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (blocked) {
      return false;
    }
  }

  return true;
}

async function syncPlanStateFromFile(ctx: ToolRuntimeContext, filePath: string): Promise<void> {
  if (!ctx.session.state.plan.planFilePath) {
    return;
  }
  if (path.resolve(filePath) !== path.resolve(ctx.session.state.plan.planFilePath)) {
    return;
  }

  const content = await Bun.file(filePath).text();
  const previousSteps = ctx.session.state.plan.steps;
  const nextSteps = parsePlanSteps(content);
  ctx.session.state.plan.steps = nextSteps;

  await ctx.emitEvent("plan.updated", { plan_file_path: filePath, steps: nextSteps });

  const previousById = new Map(previousSteps.map((step) => [step.id, step.status]));
  for (const step of nextSteps) {
    const previousStatus = previousById.get(step.id);
    if (previousStatus && previousStatus !== step.status) {
      await ctx.emitEvent("plan.step.changed", {
        step_id: step.id,
        from: previousStatus,
        to: step.status,
      });
    }
  }

  if (nextSteps.length > 0 && nextSteps.every((step) => step.status === "completed")) {
    await ctx.emitEvent("plan.completed", { plan_file_path: filePath, steps: nextSteps.length });
  }

  await ctx.sessionStore.setState(ctx.session, ctx.session.state);
}

async function recordApprovalDecision(
  ctx: ToolRuntimeContext,
  toolName: CanonicalToolName,
  decision: "allow" | "allow_this_session" | "allow_always" | "deny",
  input: unknown,
): Promise<void> {
  const decisionRecord = {
    id: `approval_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    toolName,
    decision,
    input,
  };
  await ctx.sessionStore.appendEvent(ctx.session.id, "approval.decision.recorded", {
    id: decisionRecord.id,
    timestamp: decisionRecord.timestamp,
    toolName: decisionRecord.toolName,
    decision: decisionRecord.decision,
    input: decisionRecord.input,
  });
}

async function requireToolAvailable(
  ctx: ToolRuntimeContext,
  toolName: CanonicalToolName,
): Promise<ToolResult<null>> {
  if (ctx.declaredTools && !ctx.declaredTools.includes(toolName)) {
    return err(
      "TOOL_NOT_AVAILABLE",
      `${toolName} is not declared by current runtime capabilities`,
      false,
      "Use ToolSearch to inspect declared tools",
    );
  }

  if (!isToolAllowedInProfile(ctx.profile, toolName)) {
    return err(
      "TOOL_NOT_IN_PROFILE",
      `${toolName} is not available in ${ctx.profile} profile`,
      false,
      "Use an allowed tool for this profile",
    );
  }

  if (ctx.session.state.mode === "plan") {
    if (toolName === "Bash") {
      return err(
        "TOOL_POLICY_VIOLATION",
        "Bash is disabled in plan mode",
        false,
        "Use read/search tools and update the plan file",
      );
    }
  }

  return ok(null);
}

async function enforcePlanFileGuard(
  ctx: ToolRuntimeContext,
  filePath: string,
): Promise<ToolResult<null>> {
  if (ctx.session.state.mode !== "plan") {
    return ok(null);
  }

  const planPath = ctx.session.state.plan.planFilePath;
  if (!planPath) {
    return err(
      "TOOL_POLICY_VIOLATION",
      "Plan file path is not initialized",
      false,
      "Call EnterPlanMode first",
    );
  }

  const normalized = path.resolve(filePath);
  const normalizedPlan = path.resolve(planPath);
  if (normalized !== normalizedPlan) {
    return err(
      "TOOL_POLICY_VIOLATION",
      "In plan mode, only plan file edits are allowed",
      false,
      `Edit only plan file: ${normalizedPlan}`,
    );
  }

  return ok(null);
}

function maybeNormalizePath(workspaceRoot: string, maybePath: string): string {
  return normalizeWorkspacePath(workspaceRoot, maybePath);
}

async function isWorkspacePathAllowed(
  ctx: ToolRuntimeContext,
  candidatePath: string,
  options?: { allowPlanFileInPlanMode?: boolean },
): Promise<boolean> {
  const workspaceRoot = path.resolve(ctx.workspaceRoot);
  const resolved = path.resolve(candidatePath);
  if (await isPathWithinResolved(workspaceRoot, resolved, { allowMissingLeaf: true })) {
    return true;
  }

  if (
    options?.allowPlanFileInPlanMode &&
    ctx.session.state.mode === "plan" &&
    ctx.session.state.plan.planFilePath
  ) {
    return path.resolve(ctx.session.state.plan.planFilePath) === resolved;
  }

  return false;
}

async function enforceWorkspacePathGuard(
  ctx: ToolRuntimeContext,
  toolName: CanonicalToolName,
  candidatePath: string,
  options?: { allowPlanFileInPlanMode?: boolean },
): Promise<ToolResult<null>> {
  if (await isWorkspacePathAllowed(ctx, candidatePath, options)) {
    return ok(null);
  }

  const suggestion = options?.allowPlanFileInPlanMode
    ? "Use a path inside workspace (or the current plan file in plan mode)"
    : "Use a path inside workspace";

  return err(
    "TOOL_POLICY_VIOLATION",
    `${toolName} path is outside the workspace root`,
    false,
    suggestion,
  );
}

async function maybeRequireApproval(
  ctx: ToolRuntimeContext,
  toolName: CanonicalToolName,
  input: unknown,
): Promise<ToolResult<null>> {
  const overrideDecision = ctx.approvalOverrides?.[toolName];
  if (overrideDecision === "allow") {
    await recordApprovalDecision(ctx, toolName, "allow", input);
    return ok(null);
  }
  if (overrideDecision === "deny") {
    await recordApprovalDecision(ctx, toolName, "deny", input);
    activateReminder(ctx.session, "permission_denied", { tool_name: toolName });
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
    return err(
      "TOOL_PERMISSION_DENIED",
      `${toolName} denied by host approval override`,
      false,
      "Use an alternative safe tool",
    );
  }

  const persisted = await ctx.permissionStore.isAllowed(toolName, input);
  if (persisted === true) {
    await recordApprovalDecision(ctx, toolName, "allow", input);
    return ok(null);
  }

  const decision = await ctx.onApproval({
    runId: ctx.runId,
    sessionId: ctx.session.id,
    toolName,
    input,
    reason: `${toolName} requires approval policy check`,
  });

  if (decision === "deny") {
    await recordApprovalDecision(ctx, toolName, "deny", input);
    activateReminder(ctx.session, "permission_denied", { tool_name: toolName });
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
    return err(
      "TOOL_PERMISSION_DENIED",
      `${toolName} approval denied`,
      false,
      "Propose a lower-risk alternative",
    );
  }

  await recordApprovalDecision(ctx, toolName, decision, input);
  await ctx.permissionStore.persistDecision(toolName, input, decision);
  return ok(null);
}

async function runRead(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<ReadOutput>> {
  const parsed = parseWithSchema(readInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Read arguments",
    );
  }
  const input = parsed.data;

  const pathResolved = maybeNormalizePath(ctx.workspaceRoot, input.file_path);
  const pathGuard = await enforceWorkspacePathGuard(ctx, "Read", pathResolved, {
    allowPlanFileInPlanMode: true,
  });
  if (!pathGuard.ok) {
    return pathGuard;
  }

  const baseOffset = input.offset ?? 1;
  const limit = input.limit ?? READ_LIMITS.defaultLines;

  let content: string;
  try {
    content = await Bun.file(pathResolved).text();
  } catch {
    return err(
      "TOOL_RUNTIME_ERROR",
      `Unable to read file: ${input.file_path}`,
      false,
      "Check path and permissions",
    );
  }

  const lines = content.split("\n");
  const start = Math.max(0, baseOffset - 1);
  const selected = lines.slice(start, start + limit);

  let bytes = 0;
  const outLines: Array<{ number: number; text: string }> = [];

  for (const [index, line] of selected.entries()) {
    const clipped = line.slice(0, READ_LIMITS.maxLineLength);
    const lineBytes = Buffer.byteLength(clipped, "utf8");
    if (bytes + lineBytes > READ_LIMITS.maxBytes) {
      break;
    }
    outLines.push({ number: start + index + 1, text: clipped });
    bytes += lineBytes;
  }

  const truncated = start + outLines.length < lines.length;
  const nextOffset = truncated ? start + outLines.length + 1 : null;

  return ok(
    readOutputSchema.parse({
      file_path: pathResolved,
      offset: baseOffset,
      lines: outLines,
      truncated,
      next_offset: nextOffset,
      total_lines: lines.length,
      bytes_read: bytes,
    }),
  );
}

async function runEdit(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<EditOutput>> {
  const parsed = parseWithSchema(editInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Edit arguments",
    );
  }
  const input = parsed.data;

  const pathResolved = maybeNormalizePath(ctx.workspaceRoot, input.file_path);
  const pathGuard = await enforceWorkspacePathGuard(ctx, "Edit", pathResolved, {
    allowPlanFileInPlanMode: true,
  });
  if (!pathGuard.ok) {
    return pathGuard;
  }
  const guard = await enforcePlanFileGuard(ctx, pathResolved);
  if (!guard.ok) {
    return guard;
  }

  const approval = await maybeRequireApproval(ctx, "Edit", input);
  if (!approval.ok) {
    return approval;
  }

  let original: string;
  try {
    original = await Bun.file(pathResolved).text();
  } catch {
    return err(
      "TOOL_RUNTIME_ERROR",
      `Unable to read file before edit: ${input.file_path}`,
      false,
      "Call Read first and verify path",
    );
  }

  let updated = original;
  let replacements = 0;

  if (input.replace_all) {
    const chunks = original.split(input.old_string);
    if (chunks.length > 1) {
      replacements = chunks.length - 1;
      updated = chunks.join(input.new_string);
    }
  } else {
    const index = original.indexOf(input.old_string);
    if (index >= 0) {
      updated = `${original.slice(0, index)}${input.new_string}${original.slice(index + input.old_string.length)}`;
      replacements = 1;
    }
  }

  if (replacements > 0) {
    await writeFile(pathResolved, updated, "utf8");
    await syncPlanStateFromFile(ctx, pathResolved);
  }

  return ok(
    editOutputSchema.parse({ file_path: pathResolved, replacements, changed: replacements > 0 }),
  );
}

async function runMultiEdit(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<MultiEditOutput>> {
  const parsed = parseWithSchema(multiEditInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix MultiEdit arguments",
    );
  }
  const input = parsed.data;

  const pathResolved = maybeNormalizePath(ctx.workspaceRoot, input.file_path);
  const pathGuard = await enforceWorkspacePathGuard(ctx, "MultiEdit", pathResolved, {
    allowPlanFileInPlanMode: true,
  });
  if (!pathGuard.ok) {
    return pathGuard;
  }
  const guard = await enforcePlanFileGuard(ctx, pathResolved);
  if (!guard.ok) {
    return guard;
  }

  const approval = await maybeRequireApproval(ctx, "MultiEdit", input);
  if (!approval.ok) {
    return approval;
  }

  let content: string;
  try {
    content = await Bun.file(pathResolved).text();
  } catch {
    return err(
      "TOOL_RUNTIME_ERROR",
      `Unable to read file before multi edit: ${input.file_path}`,
      false,
      "Verify file path",
    );
  }

  let replacements = 0;
  let next = content;

  for (const edit of input.edits) {
    if (edit.replace_all) {
      const chunks = next.split(edit.old_string);
      if (chunks.length > 1) {
        replacements += chunks.length - 1;
        next = chunks.join(edit.new_string);
      }
      continue;
    }

    const index = next.indexOf(edit.old_string);
    if (index >= 0) {
      next = `${next.slice(0, index)}${edit.new_string}${next.slice(index + edit.old_string.length)}`;
      replacements += 1;
    }
  }

  if (replacements > 0) {
    await writeFile(pathResolved, next, "utf8");
    await syncPlanStateFromFile(ctx, pathResolved);
  }

  return ok(
    multiEditOutputSchema.parse({
      file_path: pathResolved,
      total_replacements: replacements,
      changed: replacements > 0,
    }),
  );
}

async function runWrite(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<WriteOutput>> {
  const parsed = parseWithSchema(writeInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Write arguments",
    );
  }
  const input = parsed.data;

  const pathResolved = maybeNormalizePath(ctx.workspaceRoot, input.file_path);
  const pathGuard = await enforceWorkspacePathGuard(ctx, "Write", pathResolved, {
    allowPlanFileInPlanMode: true,
  });
  if (!pathGuard.ok) {
    return pathGuard;
  }
  const guard = await enforcePlanFileGuard(ctx, pathResolved);
  if (!guard.ok) {
    return guard;
  }

  const approval = await maybeRequireApproval(ctx, "Write", input);
  if (!approval.ok) {
    return approval;
  }

  const existedBefore = await Bun.file(pathResolved).exists();
  if (existedBefore && !input.override) {
    return err(
      "TOOL_POLICY_VIOLATION",
      `File already exists: ${input.file_path}. Set override: true to overwrite.`,
      false,
      "Set override: true or use Edit to modify the file",
    );
  }
  await mkdir(path.dirname(pathResolved), { recursive: true });
  await writeFile(pathResolved, input.content, "utf8");
  await syncPlanStateFromFile(ctx, pathResolved);

  return ok(
    writeOutputSchema.parse({
      file_path: pathResolved,
      bytes_written: Buffer.byteLength(input.content, "utf8"),
      existed_before: existedBefore,
    }),
  );
}

async function runGlob(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<GlobOutput>> {
  const parsed = parseWithSchema(globInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Glob arguments",
    );
  }
  const input = parsed.data;

  const root = maybeNormalizePath(ctx.workspaceRoot, input.path ?? ".");
  const pathGuard = await enforceWorkspacePathGuard(ctx, "Glob", root);
  if (!pathGuard.ok) {
    return pathGuard;
  }
  const hasParentTraversal = input.pattern.split(/[\\/]/).some((part) => part === "..");
  if (hasParentTraversal || path.isAbsolute(input.pattern)) {
    return err(
      "TOOL_POLICY_VIOLATION",
      "Glob pattern must stay within the workspace root",
      false,
      "Use a relative pattern without parent traversal",
    );
  }
  const glob = new Bun.Glob(input.pattern);

  const entries = await Array.fromAsync(glob.scan({ cwd: root, absolute: true }));
  const visibleEntries: string[] = [];
  for (const entry of entries) {
    if (await isWorkspacePathAllowed(ctx, entry)) {
      visibleEntries.push(entry);
    }
  }

  const sorted = visibleEntries.slice().sort((a, b) => {
    const aTime = Bun.file(a).lastModified;
    const bTime = Bun.file(b).lastModified;
    return bTime - aTime;
  });

  const matches = sorted.slice(0, GLOB_LIMITS.maxResults);

  return ok(
    globOutputSchema.parse({
      pattern: input.pattern,
      path: root,
      matches,
      truncated: sorted.length > matches.length,
      total_matches: sorted.length,
    }),
  );
}

async function runGrep(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<GrepOutput>> {
  const parsed = parseWithSchema(grepInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Grep arguments",
    );
  }
  const input = parsed.data;

  const cwd = maybeNormalizePath(ctx.workspaceRoot, input.path ?? ".");
  const pathGuard = await enforceWorkspacePathGuard(ctx, "Grep", cwd);
  if (!pathGuard.ok) {
    return pathGuard;
  }
  const headLimit = Math.min(
    input.head_limit ?? GREP_LIMITS.defaultHeadLimit,
    GREP_LIMITS.maxEntries,
  );

  const args: string[] = ["--color", "never"];
  if (input.output_mode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (input.output_mode === "count") {
    args.push("--count");
  } else {
    if (input["-n"] ?? true) {
      args.push("--line-number");
    }
  }
  if (input.glob) {
    args.push("-g", input.glob);
  }
  if (input.type) {
    args.push("--type", input.type);
  }
  if (input.multiline) {
    args.push("--multiline");
  }
  const contextLines = input["-C"] ?? input.context;
  if (typeof contextLines === "number") {
    args.push("-C", String(contextLines));
  }
  if (typeof input["-A"] === "number") {
    args.push("-A", String(input["-A"]));
  }
  if (typeof input["-B"] === "number") {
    args.push("-B", String(input["-B"]));
  }
  if (input["-i"]) {
    args.push("-i");
  }
  args.push("--", input.pattern, cwd);

  const proc = Bun.spawnSync(["rg", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: ctx.env,
  });
  if (proc.exitCode !== 0 && proc.stdout.toString().trim().length === 0) {
    return ok(
      grepOutputSchema.parse({
        pattern: input.pattern,
        path: cwd,
        total_matches: 0,
        truncated: false,
        next_offset: null,
        entries: [],
      }),
    );
  }

  const lines = proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const offset = input.offset ?? 0;
  const sliced = lines.slice(offset, offset + headLimit);

  const entries = sliced.map((line) => {
    if (input.output_mode === "count") {
      const first = line.indexOf(":");
      if (first === -1) {
        return { file_path: line, line_number: null, line };
      }
      return {
        file_path: line.slice(0, first),
        line_number: null,
        line: line.slice(first + 1).trim(),
      };
    }
    if (input.output_mode === "files_with_matches") {
      return { file_path: line, line_number: null, line: "" };
    }

    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first === -1 || second === -1) {
      return { file_path: cwd, line_number: null, line };
    }

    const filePath = line.slice(0, first);
    const lineNumber = Number.parseInt(line.slice(first + 1, second), 10);
    const matchLine = line.slice(second + 1);

    return {
      file_path: filePath,
      line_number: Number.isNaN(lineNumber) ? null : lineNumber,
      line: matchLine,
    };
  });

  const totalMatches = lines.length;
  const truncated = offset + entries.length < totalMatches;
  const nextOffset = truncated ? offset + entries.length : null;

  return ok(
    grepOutputSchema.parse({
      pattern: input.pattern,
      path: cwd,
      total_matches: totalMatches,
      truncated,
      next_offset: nextOffset,
      entries,
    }),
  );
}

async function runBash(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<BashOutput>> {
  const parsed = parseWithSchema(bashInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Bash arguments",
    );
  }
  const input = parsed.data;

  if (ctx.session.state.mode === "plan") {
    return err(
      "TOOL_POLICY_VIOLATION",
      "Bash is disabled in plan mode",
      false,
      "Exit plan mode before running commands",
    );
  }

  const approval = await maybeRequireApproval(ctx, "Bash", input);
  if (!approval.ok) {
    return approval;
  }

  const timeoutMs = Math.min(
    input.timeout ?? BASH_LIMITS.defaultTimeoutMs,
    BASH_LIMITS.maxTimeoutMs,
  );

  if (input.run_in_background) {
    const task = await ctx.taskManager.runBashBackground(
      input.command,
      timeoutMs,
      ctx.workspaceRoot,
    );
    activateReminder(ctx.session, "background_task_active", { task_id: task.id });
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
    return ok(
      bashOutputSchema.parse({
        stdout: "",
        stderr: "",
        exitCode: null,
        interrupted: false,
        backgroundTaskId: task.id,
        truncated: false,
        artifact_path: task.artifactPath,
      }),
    );
  }

  const shell = resolveShellBinary();
  const proc = Bun.spawn([shell, "-c", input.command], {
    cwd: ctx.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: ctx.env,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  const combined = `${stdout}\n${stderr}`;
  const stdoutCapped = truncateByLinesAndBytes(stdout);
  const stderrCapped = truncateByLinesAndBytes(stderr);
  const truncated =
    stdoutCapped.truncated ||
    stderrCapped.truncated ||
    Buffer.byteLength(combined, "utf8") > BASH_LIMITS.maxPreviewBytes;
  let artifactPath: string | null = null;

  if (truncated) {
    const outputDir = getSessionPaths(ctx.session.id).toolOutputDir;
    await mkdir(outputDir, { recursive: true });
    artifactPath = path.join(outputDir, `${ctx.runId}-bash-output.txt`);
    await Bun.write(artifactPath, combined);
  }

  return ok(
    bashOutputSchema.parse({
      stdout: stdoutCapped.preview,
      stderr: stderrCapped.preview,
      exitCode,
      interrupted: timedOut,
      truncated,
      artifact_path: artifactPath,
    }),
  );
}

async function runTask(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<TaskOutput>> {
  const parsed = parseWithSchema(taskInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Task arguments",
    );
  }
  const input = parsed.data;

  if (ctx.session.state.mode === "plan") {
    const requestedMode = input.mode ?? "plan";
    if (requestedMode !== "plan" && requestedMode !== "default") {
      return err(
        "TOOL_POLICY_VIOLATION",
        "Subagent mode cannot exceed parent plan constraints",
        false,
        "Use mode 'plan' or omit mode while parent is in plan mode",
      );
    }
  }

  const runInBackground = input.run_in_background ?? false;
  const task =
    input.resume && input.resume.trim().length > 0
      ? await ctx.taskManager.resumeSyntheticSubagentTask(
          input.resume,
          input.prompt,
          runInBackground,
          { description: input.description, subagentType: input.subagent_type, model: input.model },
        )
      : await ctx.taskManager.createSyntheticSubagentTask(input.prompt, runInBackground, {
          description: input.description,
          subagentType: input.subagent_type,
          model: input.model,
        });

  if (!task) {
    return err(
      "TOOL_RUNTIME_ERROR",
      `Unable to resume task: ${input.resume}`,
      false,
      "Retry without resume or provide an existing task id",
    );
  }

  await ctx.sessionStore.appendEvent(
    ctx.session.id,
    "subagent.session.started",
    {
      subagent_id: task.id,
      parent_agent_id: "main",
      status: task.status,
      description: input.description ?? null,
      subagent_type: input.subagent_type ?? null,
      model: input.model ?? null,
      resumed_from_task_id: input.resume ?? null,
      created_at: task.createdAt,
    },
    { runId: ctx.runId, scope: { kind: "subagent", agentId: task.id, parentAgentId: "main" } },
  );

  if (runInBackground) {
    activateReminder(ctx.session, "background_task_active", { task_id: task.id });
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
  }

  return ok(
    taskOutputSchema.parse({
      task_id: task.id,
      status: task.status,
      message: task.stdout,
      output_file: task.artifactPath ?? undefined,
    }),
  );
}

async function runTaskOutput(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<TaskOutputOutput>> {
  const parsed = parseWithSchema(taskOutputInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix TaskOutput arguments",
    );
  }
  const input = parsed.data;

  const task = await ctx.taskManager.getOutput(input.task_id, input.block, input.timeout);
  if (!task) {
    return err(
      "TOOL_RUNTIME_ERROR",
      `Task not found: ${input.task_id}`,
      false,
      "Check task_id and retry",
    );
  }

  const preview = ctx.taskManager.preview(task);
  if (task.type === "subagent") {
    await ctx.sessionStore.appendEvent(
      ctx.session.id,
      "subagent.session.updated",
      { subagent_id: task.id, parent_agent_id: "main", status: task.status },
      { runId: ctx.runId, scope: { kind: "subagent", agentId: task.id, parentAgentId: "main" } },
    );
  }

  if (task.status !== "running") {
    clearReminder(ctx.session, "background_task_active");
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
  }

  return ok(
    taskOutputOutputSchema.parse({
      task_id: task.id,
      status: task.status,
      stdout: preview.stdout,
      stderr: preview.stderr,
      completed: task.status !== "running" && task.status !== "queued",
      truncated: preview.truncated,
      artifact_path: preview.artifactPath,
    }),
  );
}

async function runTaskStop(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<TaskStopOutput>> {
  const parsed = parseWithSchema(taskStopInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix TaskStop arguments",
    );
  }
  const input = parsed.data;

  const taskId = input.task_id ?? input.shell_id;
  if (!taskId) {
    return err(
      "TOOL_VALIDATION_FAILED",
      "task_id or shell_id is required",
      false,
      "Set task_id or shell_id",
    );
  }

  const approval = await maybeRequireApproval(ctx, "TaskStop", input);
  if (!approval.ok) {
    return approval;
  }

  const stopped = await ctx.taskManager.stopTask(taskId);
  const task = await ctx.taskManager.getOutput(taskId, false, 1_000);
  if (task?.type === "subagent") {
    await ctx.sessionStore.appendEvent(
      ctx.session.id,
      "subagent.session.updated",
      { subagent_id: task.id, parent_agent_id: "main", status: task.status },
      { runId: ctx.runId, scope: { kind: "subagent", agentId: task.id, parentAgentId: "main" } },
    );
  }

  if (stopped) {
    clearReminder(ctx.session, "background_task_active");
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
  }

  return ok(taskStopOutputSchema.parse({ task_id: taskId, stopped }));
}

async function runWebFetch(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<WebFetchOutput>> {
  const parsed = parseWithSchema(webFetchInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix WebFetch arguments",
    );
  }
  const input = parsed.data;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_LIMITS.fetchTimeoutMs);

  let response: Response;
  try {
    response = await fetch(input.url, {
      signal: controller.signal,
      headers: { "user-agent": "coding-agent/0.1.0" },
    });
  } catch {
    clearTimeout(timer);
    return err(
      "TOOL_TIMEOUT",
      `WebFetch timed out for ${input.url}`,
      true,
      "Retry with a stable URL",
    );
  }

  clearTimeout(timer);

  const body = await response.text();
  const fullBytes = Buffer.byteLength(body, "utf8");
  const truncated = fullBytes > READ_LIMITS.maxBytes;
  const content = truncated ? body.slice(0, READ_LIMITS.maxBytes) : body;
  let artifactPath: string | null = null;

  if (truncated) {
    const outputDir = getSessionPaths(ctx.session.id).toolOutputDir;
    await mkdir(outputDir, { recursive: true });
    artifactPath = path.join(outputDir, `${ctx.runId}-webfetch.txt`);
    await Bun.write(artifactPath, body);
  }

  return ok(
    webFetchOutputSchema.parse({
      url: input.url,
      status: response.status,
      duration_ms: Date.now() - started,
      bytes: fullBytes,
      content,
      truncated,
      artifact_path: artifactPath,
    }),
  );
}

async function runWebSearch(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<WebSearchOutput>> {
  const parsed = parseWithSchema(webSearchInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix WebSearch arguments",
    );
  }
  const input = parsed.data;

  const topK = Math.min(input.top_k ?? WEB_LIMITS.searchDefaultTopK, WEB_LIMITS.searchMaxTopK);

  const wsConfig = ctx.providerConfig?.webSearch;
  const wsFallbackConfig = ctx.providerConfig?.webSearchFallback;
  const apiKey = wsConfig?.apiKey ?? process.env.OPENROUTER_API_KEY;
  const primaryModel = wsConfig?.modelId ?? process.env.OPENROUTER_WEBSEARCH_MODEL;

  const message =
    "WebSearch provider is not configured. Set OPENROUTER_API_KEY and OPENROUTER_WEBSEARCH_MODEL to enable this tool.";
  if (!apiKey || !primaryModel) {
    return err(
      "WEBSEARCH_UNAVAILABLE",
      message,
      true,
      "Configure OpenRouter credentials and retry",
    );
  }

  const normalizedQuery = normalizeRecencyQuery(input.query);

  const domainHints = [
    ...(input.allowed_domains ?? []).map((domain) => `site:${domain}`),
    ...(input.blocked_domains ?? []).map((domain) => `-site:${domain}`),
  ].join(" ");

  const fullQuery = `${normalizedQuery} ${domainHints}`.trim();
  const started = Date.now();
  const provider = createOpenRouter({ apiKey, compatibility: "strict" });
  const fallbackModel =
    wsFallbackConfig?.modelId ?? process.env.OPENROUTER_WEBSEARCH_FALLBACK_MODEL;

  const resultSchema = z.object({
    query: z.string(),
    results: z.array(z.object({ title: z.string(), url: z.string().url(), snippet: z.string() })),
  });

  async function searchWithModel(modelId: string, overrideProvider?: OpenRouterProvider) {
    const { object } = await generateObject({
      model: (overrideProvider ?? provider)(modelId),
      schema: resultSchema,
      prompt: `Search the web for: ${fullQuery}. Return at most ${topK} results.`,
      providerOptions: {
        openrouter: {
          plugins: [{ id: "web", max_results: topK }],
          web_search_options: { max_results: topK },
        },
      },
    });
    return object;
  }

  let searchOutput: z.infer<typeof resultSchema>;
  try {
    searchOutput = await searchWithModel(primaryModel);
  } catch (primaryError) {
    if (!fallbackModel) {
      return err(
        "WEBSEARCH_UNAVAILABLE",
        primaryError instanceof Error ? primaryError.message : "WebSearch primary model failed",
        true,
        "Configure OPENROUTER_WEBSEARCH_FALLBACK_MODEL or retry",
      );
    }

    try {
      const fbApiKey = wsFallbackConfig?.apiKey;
      const fbProvider =
        fbApiKey && fbApiKey !== apiKey
          ? createOpenRouter({ apiKey: fbApiKey, compatibility: "strict" })
          : undefined;
      searchOutput = await searchWithModel(fallbackModel, fbProvider);
    } catch (fallbackError) {
      return err(
        "WEBSEARCH_UNAVAILABLE",
        fallbackError instanceof Error ? fallbackError.message : "WebSearch fallback failed",
        true,
        "Retry with narrower query or check model/plugin availability",
      );
    }
  }

  const filtered = searchOutput.results
    .filter((item) => matchesDomainFilters(item.url, input.allowed_domains, input.blocked_domains))
    .slice(0, topK);

  return ok(
    webSearchOutputSchema.parse({
      query: searchOutput.query,
      results: filtered,
      duration_seconds: (Date.now() - started) / 1000,
    }),
  );
}

async function runAskUserQuestion(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<AskUserQuestionOutput>> {
  const parsed = parseWithSchema(askUserQuestionInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix AskUserQuestion arguments",
    );
  }
  const input = parsed.data;

  for (const question of input.questions) {
    const firstLabel = question.options[0]?.label ?? "";
    if (!firstLabel.includes("(Recommended)")) {
      return err(
        "TOOL_VALIDATION_FAILED",
        "AskUserQuestion requires recommended option first",
        false,
        "Put the recommended choice first and suffix it with '(Recommended)'",
      );
    }
  }

  const response = await ctx.onHumanQuestion({
    runId: ctx.runId,
    sessionId: ctx.session.id,
    toolName: "AskUserQuestion",
    input,
  });

  const outputParsed = askUserQuestionOutputSchema.safeParse(response);
  if (!outputParsed.success) {
    return err(
      "TOOL_RUNTIME_ERROR",
      "Invalid human response payload",
      true,
      "Return answers that match AskUserQuestion schema",
    );
  }

  return ok(outputParsed.data);
}

async function runEnterPlanMode(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<EnterPlanModeOutput>> {
  const parsed = parseWithSchema(enterPlanModeInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "EnterPlanMode does not accept custom fields",
    );
  }

  ctx.session.state.mode = "plan";
  ctx.session.state.profile = "plan";

  if (!ctx.session.state.plan.planFilePath) {
    await ensureStateLayout();
    const layout = getStateLayout();
    await mkdir(layout.plansDir, { recursive: true });
    const planPath = path.join(layout.plansDir, createPlanFileName());
    await Bun.write(planPath, "# Plan\n\n");
    ctx.session.state.plan.planFilePath = planPath;
    await ctx.emitEvent("plan.created", { plan_file_path: planPath });
  }

  await ctx.sessionStore.setState(ctx.session, ctx.session.state);
  await ctx.emitEvent("plan.mode.entered", { plan_file_path: ctx.session.state.plan.planFilePath });

  return ok(
    enterPlanModeOutputSchema.parse({
      mode: "plan",
      plan_file_path: ctx.session.state.plan.planFilePath,
    }),
  );
}

async function runExitPlanMode(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<ExitPlanModeOutput>> {
  const parsed = parseWithSchema(exitPlanModeInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix ExitPlanMode arguments",
    );
  }
  const _input = parsed.data;

  const planPath = ctx.session.state.plan.planFilePath;
  if (!planPath) {
    return err(
      "TOOL_POLICY_VIOLATION",
      "Cannot exit plan mode without a plan file",
      false,
      "Create and populate a plan file first",
    );
  }

  const exists = await Bun.file(planPath).exists();
  if (!exists) {
    return err(
      "TOOL_POLICY_VIOLATION",
      "Cannot exit plan mode because plan file is missing",
      false,
      "Write the plan file before exiting",
    );
  }

  const decision = await ctx.onApproval({
    runId: ctx.runId,
    sessionId: ctx.session.id,
    toolName: "ExitPlanMode",
    input: { planPath },
    reason: "ExitPlanMode requires explicit plan approval",
  });

  if (decision === "deny") {
    activateReminder(ctx.session, "permission_denied", { tool_name: "ExitPlanMode" });
    await ctx.sessionStore.setState(ctx.session, ctx.session.state);
    return ok(exitPlanModeOutputSchema.parse({ approved: false, mode: "plan" }));
  }

  ctx.session.state.mode = "execute";
  ctx.session.state.profile = "execute";
  ctx.session.state.plan.approved = true;
  activateReminder(ctx.session, "plan_mode_exited", { plan_file_path: planPath });

  await ctx.permissionStore.persistDecision("ExitPlanMode", { planPath }, decision);
  await ctx.sessionStore.setState(ctx.session, ctx.session.state);
  await ctx.emitEvent("plan.mode.exited", { plan_file_path: planPath, approved: true });

  return ok(exitPlanModeOutputSchema.parse({ approved: true, mode: "execute" }));
}

async function runTodoWrite(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<TodoWriteOutput>> {
  const parsed = parseWithSchema(todoWriteInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix TodoWrite arguments",
    );
  }
  const input = parsed.data;

  const inProgressCount = input.todos.filter((todo) => todo.status === "in_progress").length;
  if (inProgressCount > 1) {
    return err(
      "TOOL_POLICY_VIOLATION",
      "Only one todo item can be in_progress",
      false,
      "Set at most one in_progress todo",
    );
  }

  ctx.session.state.todos = input.todos;
  await ctx.sessionStore.setState(ctx.session, ctx.session.state);

  return ok(todoWriteOutputSchema.parse({ todos: input.todos, updated: true }));
}

async function runTodoRead(
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<TodoReadOutput>> {
  const parsed = parseWithSchema(todoReadInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "TodoRead takes no input",
    );
  }

  return ok(todoReadOutputSchema.parse({ todos: ctx.session.state.todos }));
}

async function runToolSearch(
  rawInput: unknown,
  _ctx: ToolRuntimeContext,
): Promise<ToolResult<ToolSearchOutput>> {
  const parsed = parseWithSchema(toolSearchInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix ToolSearch arguments",
    );
  }
  const input = parsed.data;

  const required = input.query
    .split(/\s+/)
    .filter((token) => token.startsWith("+"))
    .map((token) => token.slice(1).toLowerCase());
  const plain = input.query
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("+"))
    .map((token) => token.toLowerCase());

  const selectPrefix = "select:";
  const direct = input.query.toLowerCase().startsWith(selectPrefix)
    ? input.query.slice(selectPrefix.length)
    : null;

  const matches = CANONICAL_TOOLS.filter((tool) => {
    const lower = tool.toLowerCase();
    if (direct) {
      return lower === direct.toLowerCase();
    }
    if (required.some((token) => !lower.includes(token))) {
      return false;
    }
    if (plain.length === 0) {
      return true;
    }
    return plain.some((token) => lower.includes(token));
  })
    .slice(0, input.max_results)
    .map((name) => ({ name, description: `Tool ${name}` }));

  return ok(toolSearchOutputSchema.parse({ query: input.query, matches }));
}

async function runSkill(
  rawInput: unknown,
  _ctx: ToolRuntimeContext,
): Promise<ToolResult<SkillOutput>> {
  const parsed = parseWithSchema(skillInputSchema, rawInput);
  if (!parsed.success) {
    return err(
      parsed.unknownField ? "TOOL_VALIDATION_UNKNOWN_FIELD" : "TOOL_VALIDATION_FAILED",
      parsed.message,
      false,
      "Fix Skill arguments",
    );
  }
  const input = parsed.data;

  return ok(
    skillOutputSchema.parse({
      skill: input.skill,
      invoked: true,
      message: `Skill '${input.skill}' acknowledged by coding-agent runtime`,
    }),
  );
}

const runtimeTools: RuntimeTool[] = [
  {
    name: "Read",
    description: "Read files with pagination",
    requiresApproval: false,
    execute: runRead,
  },
  { name: "Edit", description: "Find/replace in a file", requiresApproval: true, execute: runEdit },
  { name: "Write", description: "Write file content", requiresApproval: true, execute: runWrite },
  {
    name: "MultiEdit",
    description: "Apply batch edits atomically",
    requiresApproval: true,
    execute: runMultiEdit,
  },
  {
    name: "Glob",
    description: "Search files with glob pattern",
    requiresApproval: false,
    execute: runGlob,
  },
  {
    name: "Grep",
    description: "Search content with grep semantics",
    requiresApproval: false,
    execute: runGrep,
  },
  { name: "Bash", description: "Execute shell command", requiresApproval: true, execute: runBash },
  { name: "Task", description: "Run a subagent task", requiresApproval: false, execute: runTask },
  {
    name: "TaskOutput",
    description: "Retrieve task output",
    requiresApproval: false,
    execute: runTaskOutput,
  },
  {
    name: "TaskStop",
    description: "Stop running task",
    requiresApproval: true,
    execute: runTaskStop,
  },
  {
    name: "WebFetch",
    description: "Fetch and summarize web page",
    requiresApproval: false,
    execute: runWebFetch,
  },
  {
    name: "WebSearch",
    description: "Search web via OpenRouter web plugin",
    requiresApproval: false,
    execute: runWebSearch,
  },
  {
    name: "AskUserQuestion",
    description: "Ask structured user questions",
    requiresApproval: false,
    execute: runAskUserQuestion,
  },
  {
    name: "EnterPlanMode",
    description: "Switch to plan mode",
    requiresApproval: false,
    execute: runEnterPlanMode,
  },
  {
    name: "ExitPlanMode",
    description: "Exit plan mode after approval",
    requiresApproval: true,
    execute: runExitPlanMode,
  },
  {
    name: "TodoWrite",
    description: "Update todo list",
    requiresApproval: false,
    execute: runTodoWrite,
  },
  {
    name: "TodoRead",
    description: "Read todo list",
    requiresApproval: false,
    execute: runTodoRead,
  },
  {
    name: "ToolSearch",
    description: "Search tools",
    requiresApproval: false,
    execute: runToolSearch,
  },
  {
    name: "Skill",
    description: "Invoke runtime skill",
    requiresApproval: false,
    execute: runSkill,
  },
];

const runtimeByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));

export async function invokeToolByName(
  rawName: string,
  rawInput: unknown,
  ctx: ToolRuntimeContext,
): Promise<ToolResult<unknown>> {
  const normalized = normalizeToolName(rawName);
  if (!normalized) {
    return err(
      "TOOL_NOT_AVAILABLE",
      `Unknown tool: ${rawName}`,
      false,
      "Use ToolSearch to inspect available tools",
    );
  }

  const availability = await requireToolAvailable(ctx, normalized);
  if (!availability.ok) {
    return availability;
  }

  const tool = runtimeByName.get(normalized);
  if (!tool) {
    return err(
      "TOOL_NOT_AVAILABLE",
      `Tool not implemented: ${normalized}`,
      false,
      "Remove tool call or enable tool implementation",
    );
  }

  const result = await tool.execute(rawInput, ctx);

  return result;
}

export function getToolSchemasForExport(): typeof toolSchemas {
  return toolSchemas;
}
