import { z } from "zod";

import {
  BASH_LIMITS,
  GREP_LIMITS,
  READ_LIMITS,
  TASK_OUTPUT_LIMITS,
  WEB_LIMITS,
} from "../core/constants.ts";

const nonEmptyString = z.string().min(1);

export const readInputSchema = z
  .object({
    file_path: nonEmptyString,
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(READ_LIMITS.defaultLines).optional(),
  })
  .strict();

export const readOutputSchema = z
  .object({
    file_path: z.string(),
    offset: z.number().int().min(1),
    lines: z.array(z.object({ number: z.number().int().min(1), text: z.string() })),
    truncated: z.boolean(),
    next_offset: z.number().int().min(1).nullable(),
    total_lines: z.number().int().min(0),
    bytes_read: z.number().int().min(0),
  })
  .strict();

export const editInputSchema = z
  .object({
    file_path: nonEmptyString,
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })
  .strict();

export const editOutputSchema = z
  .object({ file_path: z.string(), replacements: z.number().int().min(0), changed: z.boolean() })
  .strict();

export const multiEditInputSchema = z
  .object({
    file_path: nonEmptyString,
    edits: z
      .array(
        z
          .object({
            old_string: z.string(),
            new_string: z.string(),
            replace_all: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const multiEditOutputSchema = z
  .object({
    file_path: z.string(),
    total_replacements: z.number().int().min(0),
    changed: z.boolean(),
  })
  .strict();

export const writeInputSchema = z
  .object({
    file_path: nonEmptyString,
    content: z.string(),
    override: z.boolean().optional().default(false),
  })
  .strict();

export const writeOutputSchema = z
  .object({
    file_path: z.string(),
    bytes_written: z.number().int().min(0),
    existed_before: z.boolean(),
  })
  .strict();

export const globInputSchema = z
  .object({ pattern: nonEmptyString, path: z.string().optional() })
  .strict();

export const globOutputSchema = z
  .object({
    pattern: z.string(),
    path: z.string(),
    matches: z.array(z.string()),
    truncated: z.boolean(),
    total_matches: z.number().int().min(0),
  })
  .strict();

export const grepInputSchema = z
  .object({
    pattern: nonEmptyString,
    path: z.string().optional(),
    glob: z.string().optional(),
    type: z.string().optional(),
    output_mode: z.enum(["files_with_matches", "content", "count"]).optional(),
    multiline: z.boolean().optional(),
    head_limit: z.number().int().min(1).max(GREP_LIMITS.maxEntries).optional(),
    offset: z.number().int().min(0).optional(),
    context: z.number().int().min(0).optional(),
    "-A": z.number().int().min(0).optional(),
    "-B": z.number().int().min(0).optional(),
    "-C": z.number().int().min(0).optional(),
    "-i": z.boolean().optional(),
    "-n": z.boolean().optional(),
  })
  .strict();

export const grepOutputSchema = z
  .object({
    pattern: z.string(),
    path: z.string(),
    total_matches: z.number().int().min(0),
    truncated: z.boolean(),
    next_offset: z.number().int().min(0).nullable(),
    entries: z.array(
      z
        .object({
          file_path: z.string(),
          line_number: z.number().int().min(1).nullable(),
          line: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const bashInputSchema = z
  .object({
    command: nonEmptyString,
    timeout: z.number().int().min(1).max(BASH_LIMITS.maxTimeoutMs).optional(),
    description: z.string().optional(),
    run_in_background: z.boolean().optional(),
    dangerouslyDisableSandbox: z.boolean().optional(),
    _simulatedSedEdit: z.string().optional(),
  })
  .strict();

export const bashOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
    interrupted: z.boolean(),
    backgroundTaskId: z.string().optional(),
    truncated: z.boolean(),
    artifact_path: z.string().nullable(),
  })
  .strict();

export const taskInputSchema = z
  .object({
    description: nonEmptyString,
    prompt: nonEmptyString,
    subagent_type: nonEmptyString,
    model: z.enum(["sonnet", "opus", "haiku"]).optional(),
    resume: z.string().optional(),
    run_in_background: z.boolean().optional(),
    max_turns: z.number().int().positive().optional(),
    name: z.string().optional(),
    team_name: z.string().optional(),
    mode: z
      .enum(["acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan"])
      .optional(),
  })
  .strict();

export const taskOutputSchema = z
  .object({
    task_id: z.string(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    message: z.string(),
    output_file: z.string().optional(),
  })
  .strict();

export const taskOutputInputSchema = z
  .object({
    task_id: nonEmptyString,
    block: z.boolean().default(TASK_OUTPUT_LIMITS.defaultBlock),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(TASK_OUTPUT_LIMITS.maxTimeoutMs)
      .default(TASK_OUTPUT_LIMITS.defaultTimeoutMs),
  })
  .strict();

export const taskOutputOutputSchema = z
  .object({
    task_id: z.string(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    stdout: z.string(),
    stderr: z.string(),
    completed: z.boolean(),
    truncated: z.boolean(),
    artifact_path: z.string().nullable(),
  })
  .strict();

export const taskStopInputSchema = z
  .object({ task_id: z.string().optional(), shell_id: z.string().optional() })
  .strict()
  .refine((val) => Boolean(val.task_id || val.shell_id), {
    message: "At least one of task_id or shell_id is required",
  });

export const taskStopOutputSchema = z
  .object({ task_id: z.string(), stopped: z.boolean() })
  .strict();

export const webFetchInputSchema = z
  .object({ url: z.string().url(), prompt: z.string().min(1) })
  .strict();

export const webFetchOutputSchema = z
  .object({
    url: z.string().url(),
    status: z.number().int(),
    duration_ms: z.number().int().min(0),
    bytes: z.number().int().min(0),
    content: z.string(),
    truncated: z.boolean(),
    artifact_path: z.string().nullable(),
  })
  .strict();

export const webSearchInputSchema = z
  .object({
    query: z.string().min(1),
    allowed_domains: z.array(z.string().min(1)).optional(),
    blocked_domains: z.array(z.string().min(1)).optional(),
    top_k: z.number().int().min(1).max(WEB_LIMITS.searchMaxTopK).optional(),
  })
  .strict();

export const webSearchOutputSchema = z
  .object({
    query: z.string(),
    results: z.array(
      z.object({ title: z.string(), url: z.string().url(), snippet: z.string() }).strict(),
    ),
    duration_seconds: z.number().min(0),
  })
  .strict();

const askOptionSchema = z
  .object({ label: z.string().min(1), description: z.string().min(1) })
  .strict();

const askQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    question: z.string().min(1),
    header: z.string().min(1).max(12),
    options: z.array(askOptionSchema).min(2).max(4),
    multiSelect: z.boolean().optional(),
  })
  .strict();

export const askUserQuestionInputSchema = z
  .object({
    questions: z.array(askQuestionSchema).min(1).max(3),
    answers: z.record(z.string(), z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const askUserQuestionOutputSchema = z
  .object({
    answers: z.record(z.string(), z.array(z.string())),
    freeform: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const enterPlanModeInputSchema = z.object({}).strict();

export const enterPlanModeOutputSchema = z
  .object({ mode: z.literal("plan"), plan_file_path: z.string() })
  .strict();

export const exitPlanModeInputSchema = z
  .object({
    allowedPrompts: z.array(z.object({ tool: z.string(), prompt: z.string() }).strict()).optional(),
    pushToRemote: z.boolean().optional(),
    remoteSessionId: z.string().optional(),
    remoteSessionTitle: z.string().optional(),
    remoteSessionUrl: z.string().optional(),
  })
  .strict();

export const exitPlanModeOutputSchema = z
  .object({ approved: z.boolean(), mode: z.enum(["plan", "execute"]) })
  .strict();

const todoItemSchema = z
  .object({
    content: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    activeForm: z.string().min(1),
  })
  .strict();

export const todoWriteInputSchema = z.object({ todos: z.array(todoItemSchema) }).strict();

export const todoWriteOutputSchema = z
  .object({ todos: z.array(todoItemSchema), updated: z.boolean() })
  .strict();

export const todoReadInputSchema = z.object({}).strict();

export const todoReadOutputSchema = z.object({ todos: z.array(todoItemSchema) }).strict();

export const toolSearchInputSchema = z
  .object({ query: z.string().min(1), max_results: z.number().int().positive() })
  .strict();

export const toolSearchOutputSchema = z
  .object({
    query: z.string(),
    matches: z.array(z.object({ name: z.string(), description: z.string() }).strict()),
  })
  .strict();

export const skillInputSchema = z
  .object({ skill: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() })
  .strict();

export const skillOutputSchema = z
  .object({ skill: z.string(), invoked: z.boolean(), message: z.string() })
  .strict();

export const toolSchemas = {
  Read: { input: readInputSchema, output: readOutputSchema },
  Edit: { input: editInputSchema, output: editOutputSchema },
  Write: { input: writeInputSchema, output: writeOutputSchema },
  MultiEdit: { input: multiEditInputSchema, output: multiEditOutputSchema },
  Glob: { input: globInputSchema, output: globOutputSchema },
  Grep: { input: grepInputSchema, output: grepOutputSchema },
  Bash: { input: bashInputSchema, output: bashOutputSchema },
  Task: { input: taskInputSchema, output: taskOutputSchema },
  TaskOutput: { input: taskOutputInputSchema, output: taskOutputOutputSchema },
  TaskStop: { input: taskStopInputSchema, output: taskStopOutputSchema },
  WebFetch: { input: webFetchInputSchema, output: webFetchOutputSchema },
  WebSearch: { input: webSearchInputSchema, output: webSearchOutputSchema },
  AskUserQuestion: { input: askUserQuestionInputSchema, output: askUserQuestionOutputSchema },
  EnterPlanMode: { input: enterPlanModeInputSchema, output: enterPlanModeOutputSchema },
  ExitPlanMode: { input: exitPlanModeInputSchema, output: exitPlanModeOutputSchema },
  TodoWrite: { input: todoWriteInputSchema, output: todoWriteOutputSchema },
  TodoRead: { input: todoReadInputSchema, output: todoReadOutputSchema },
  ToolSearch: { input: toolSearchInputSchema, output: toolSearchOutputSchema },
  Skill: { input: skillInputSchema, output: skillOutputSchema },
} as const;

export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadOutput = z.infer<typeof readOutputSchema>;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;

export type MultiEditInput = z.infer<typeof multiEditInputSchema>;
export type MultiEditOutput = z.infer<typeof multiEditOutputSchema>;

export type WriteInput = z.infer<typeof writeInputSchema>;
export type WriteOutput = z.infer<typeof writeOutputSchema>;

export type GlobInput = z.infer<typeof globInputSchema>;
export type GlobOutput = z.infer<typeof globOutputSchema>;

export type GrepInput = z.infer<typeof grepInputSchema>;
export type GrepOutput = z.infer<typeof grepOutputSchema>;

export type BashInput = z.infer<typeof bashInputSchema>;
export type BashOutput = z.infer<typeof bashOutputSchema>;

export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskOutput = z.infer<typeof taskOutputSchema>;

export type TaskOutputInput = z.infer<typeof taskOutputInputSchema>;
export type TaskOutputOutput = z.infer<typeof taskOutputOutputSchema>;

export type TaskStopInput = z.infer<typeof taskStopInputSchema>;
export type TaskStopOutput = z.infer<typeof taskStopOutputSchema>;

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export type WebFetchOutput = z.infer<typeof webFetchOutputSchema>;

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;
export type AskUserQuestionOutput = z.infer<typeof askUserQuestionOutputSchema>;

export type EnterPlanModeInput = z.infer<typeof enterPlanModeInputSchema>;
export type EnterPlanModeOutput = z.infer<typeof enterPlanModeOutputSchema>;

export type ExitPlanModeInput = z.infer<typeof exitPlanModeInputSchema>;
export type ExitPlanModeOutput = z.infer<typeof exitPlanModeOutputSchema>;

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;
export type TodoWriteOutput = z.infer<typeof todoWriteOutputSchema>;

export type TodoReadInput = z.infer<typeof todoReadInputSchema>;
export type TodoReadOutput = z.infer<typeof todoReadOutputSchema>;

export type ToolSearchInput = z.infer<typeof toolSearchInputSchema>;
export type ToolSearchOutput = z.infer<typeof toolSearchOutputSchema>;

export type SkillInput = z.infer<typeof skillInputSchema>;
export type SkillOutput = z.infer<typeof skillOutputSchema>;
