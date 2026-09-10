/**
 * Verifiable completion conditions for goal-directed behavior.
 *
 * When the model signals completion, these conditions verify that
 * the task is actually complete before allowing the loop to exit.
 */

import type { LanguageModel } from "ai";
import { generateObject } from "ai";
import { z } from "zod";

import { resolveShellBinary } from "../utils/shell.ts";

/** Default timeout for shell commands in milliseconds. */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Validate a timestamp string to prevent command injection.
 * Only allows ISO date strings and relative git date formats.
 */
function validateTimestamp(since: string): boolean {
  // Allow ISO dates: 2024-01-15, 2024-01-15T10:30:00Z
  const isoPattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/;
  // Allow relative git dates: "1 hour ago", "2 days ago", "3 weeks ago"
  const relativePattern = /^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

  return isoPattern.test(since) || relativePattern.test(since);
}

/**
 * Types of completion conditions that can be verified.
 */
export type CompletionCondition =
  | { type: "tests_pass"; command: string }
  | { type: "typecheck"; command: string }
  | { type: "lint_clean"; command: string }
  | { type: "pr_created" }
  | { type: "commit_created"; since: string }
  | { type: "no_uncommitted_changes" }
  | { type: "build_succeeds"; command: string }
  | { type: "tasks_complete" };

/**
 * Result of verifying a single condition.
 */
export interface ConditionResult {
  condition: CompletionCondition;
  met: boolean;
  details?: string;
}

/**
 * Result of verifying all completion conditions.
 */
export interface VerificationResult {
  allMet: boolean;
  results: ConditionResult[];
}

/**
 * Task status for tasks_complete condition.
 */
export interface TaskStatus {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Context needed for completion verification.
 */
export interface VerificationContext {
  workspaceRoot: string;
  listTasks?: () => Promise<TaskStatus[]>;
  env?: Record<string, string | undefined>;
}

/**
 * Run a shell command and capture result with timeout.
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
  env?: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const shell = resolveShellBinary();
  const proc = Bun.spawn([shell, "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);

    const [stdout, stderr, exitCode] = result;
    return { exitCode, stdout, stderr };
  } catch (error) {
    // Timeout or other error
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Command execution failed",
    };
  }
}

/**
 * Verify a command-based condition (tests, typecheck, lint, build).
 */
async function verifyCommandCondition(
  condition: { type: string; command: string },
  ctx: VerificationContext,
): Promise<ConditionResult> {
  const result = await runCommand(
    condition.command,
    ctx.workspaceRoot,
    COMMAND_TIMEOUT_MS,
    ctx.env,
  );
  return {
    condition: condition as CompletionCondition,
    met: result.exitCode === 0,
    details: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

/**
 * Verify a single completion condition.
 */
async function verifyCondition(
  condition: CompletionCondition,
  ctx: VerificationContext,
): Promise<ConditionResult> {
  switch (condition.type) {
    case "tests_pass":
    case "typecheck":
    case "lint_clean":
    case "build_succeeds":
      return verifyCommandCondition(condition, ctx);

    case "no_uncommitted_changes": {
      const result = await runCommand(
        "git status --porcelain",
        ctx.workspaceRoot,
        COMMAND_TIMEOUT_MS,
        ctx.env,
      );
      const clean = result.stdout.trim() === "";
      return {
        condition,
        met: clean,
        details: clean ? undefined : `Uncommitted changes:\n${result.stdout}`,
      };
    }

    case "pr_created": {
      const result = await runCommand(
        "gh pr view --json url 2>/dev/null",
        ctx.workspaceRoot,
        COMMAND_TIMEOUT_MS,
        ctx.env,
      );
      return {
        condition,
        met: result.exitCode === 0,
        details: result.exitCode !== 0 ? "No PR found for current branch" : undefined,
      };
    }

    case "commit_created": {
      // Validate timestamp to prevent command injection
      if (!validateTimestamp(condition.since)) {
        return { condition, met: false, details: `Invalid timestamp format: ${condition.since}` };
      }
      const result = await runCommand(
        `git log --oneline --since="${condition.since}" -1`,
        ctx.workspaceRoot,
        COMMAND_TIMEOUT_MS,
        ctx.env,
      );
      const hasCommit = result.stdout.trim().length > 0;
      return {
        condition,
        met: hasCommit,
        details: hasCommit ? undefined : `No commits since ${condition.since}`,
      };
    }

    case "tasks_complete": {
      if (!ctx.listTasks) {
        // No task manager available, consider condition met
        return { condition, met: true };
      }

      const tasks = await ctx.listTasks();
      const incomplete = tasks.filter((t) => t.status !== "completed");
      return {
        condition,
        met: incomplete.length === 0,
        details:
          incomplete.length > 0
            ? `${incomplete.length} tasks incomplete: ${incomplete.map((t) => t.subject).join(", ")}`
            : undefined,
      };
    }

    default: {
      const _exhaustive: never = condition;
      throw new Error(`Unknown completion condition type: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Verify all completion conditions.
 */
export async function verifyConditions(
  conditions: CompletionCondition[],
  ctx: VerificationContext,
): Promise<VerificationResult> {
  if (conditions.length === 0) {
    return { allMet: true, results: [] };
  }

  const results = await Promise.all(conditions.map((c) => verifyCondition(c, ctx)));

  return { allMet: results.every((r) => r.met), results };
}

/**
 * Schema for LLM-identified completion conditions.
 */
const IdentifiedConditionsSchema = z.object({
  conditions: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("tests_pass"), command: z.string() }),
      z.object({ type: z.literal("typecheck"), command: z.string() }),
      z.object({ type: z.literal("lint_clean"), command: z.string() }),
      z.object({ type: z.literal("build_succeeds"), command: z.string() }),
      z.object({ type: z.literal("pr_created") }),
      z.object({ type: z.literal("commit_created"), since: z.string() }),
      z.object({ type: z.literal("no_uncommitted_changes") }),
      z.object({ type: z.literal("tasks_complete") }),
    ]),
  ),
  reasoning: z.string().describe("Why these conditions are appropriate for this task"),
});

/**
 * Use LLM to identify completion conditions for a task.
 *
 * @param task - The user's task/request
 * @param model - LLM to use for analysis
 * @param projectContext - Optional context about the project (package.json scripts, etc.)
 * @returns List of applicable completion conditions, empty array on error
 */
export async function identifyConditions(
  task: string,
  model: LanguageModel,
  projectContext?: string,
): Promise<CompletionCondition[]> {
  try {
    const { object } = await generateObject({
      model,
      schema: IdentifiedConditionsSchema,
      prompt: `Analyze this task and identify what completion conditions should be verified before considering it done.

## Task
${task}

${projectContext ? `## Project Context\n${projectContext}\n` : ""}

## Available Condition Types
- tests_pass: Run test command and verify exit code 0
- typecheck: Run typecheck command and verify exit code 0
- lint_clean: Run lint command and verify exit code 0
- build_succeeds: Run build command and verify exit code 0
- pr_created: Verify a PR exists for current branch
- commit_created: Verify commits exist since a timestamp
- no_uncommitted_changes: Verify git working tree is clean
- tasks_complete: Verify all todo tasks are marked complete

## Guidelines
- Only include conditions that are clearly implied by the task
- For code changes, typically include typecheck and lint_clean
- For "create PR" tasks, include pr_created
- For bug fixes, include relevant tests if mentioned
- Don't be overly strict - only include essential conditions
- If task is purely exploratory/research, return empty conditions`,
    });

    return object.conditions;
  } catch {
    // If LLM call fails, return empty conditions to avoid blocking
    return [];
  }
}

/**
 * Format unmet conditions into a reminder message.
 */
export function formatUnmetConditions(results: ConditionResult[]): string {
  const unmet = results.filter((r) => !r.met);
  if (unmet.length === 0) {
    return "";
  }

  const lines = unmet.map((r) => {
    const typeLabel = r.condition.type.replace(/_/g, " ");
    const details = r.details ? `: ${r.details.slice(0, 200)}` : "";
    return `- ${typeLabel}${details}`;
  });

  return `You indicated completion, but these conditions are not met:\n${lines.join("\n")}\n\nPlease address these before finishing.`;
}
