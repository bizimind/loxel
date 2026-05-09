/**
 * LLM-based judgment layer for determining if agent is making progress or stuck.
 */

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

/**
 * Schema for LLM judgment of agent progress.
 */
export const LoopJudgmentSchema = z.object({
  verdict: z.enum(["productive", "stuck", "uncertain"]),
  reasoning: z.string().describe("Brief explanation of the judgment"),
  suggestion: z.string().optional().describe("What to tell the agent if stuck"),
});

export type LoopJudgment = z.infer<typeof LoopJudgmentSchema>;

/**
 * Summary of a tool call for judgment context.
 */
export interface ToolCallSummary {
  tool: string;
  input: unknown;
  output: unknown;
  timestamp: number;
}

/**
 * Context provided to the LLM judge.
 */
export interface JudgeContext {
  /** Original user request/task. */
  task: string;
  /** Recent tool calls with outputs. */
  toolCalls: ToolCallSummary[];
  /** If triggered by cycle detection. */
  cycleInfo?: { cycleLength: number; pattern: string[] };
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 3)}...`;
}

/**
 * Summarize the distribution of tool calls for context.
 */
function summarizeDistribution(calls: ToolCallSummary[]): string {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    counts[call.tool] = (counts[call.tool] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => `${tool}(${count})`)
    .join(", ");
}

/**
 * Judge whether the agent is making progress or is stuck in a loop.
 *
 * @param ctx - Context including task and recent tool calls
 * @param model - Fast model for judgment (e.g., Haiku)
 * @returns Judgment with verdict, reasoning, and optional suggestion
 */
export async function judgeProgress(
  ctx: JudgeContext,
  model: LanguageModel,
): Promise<LoopJudgment> {
  // Keep last 20 calls with full detail, summarize earlier ones
  const recentCalls = ctx.toolCalls.slice(-20);
  const earlierCount = ctx.toolCalls.length - 20;

  const toolCallsSection = recentCalls
    .map(
      (tc, i) =>
        `${i + 1}. ${tc.tool}(${truncate(JSON.stringify(tc.input), 100)})\n     → ${truncate(JSON.stringify(tc.output), 200)}`,
    )
    .join("\n\n");

  const cycleSection = ctx.cycleInfo
    ? `
## Detected Pattern
The following pattern repeated ${ctx.cycleInfo.cycleLength} times:
${ctx.cycleInfo.pattern.join(" → ")}
`
    : "";

  const earlierSection =
    earlierCount > 0
      ? `## Earlier Activity\n${earlierCount} tool calls before these (summarized: ${summarizeDistribution(ctx.toolCalls.slice(0, -20))})\n`
      : "";

  const prompt = `You are analyzing an AI agent's tool call sequence to determine if it's making progress or stuck in a loop.

## Original Task
${ctx.task}

${earlierSection}
## Recent Tool Calls
${toolCallsSection}
${cycleSection}
## Judgment Criteria
- **productive**: Making meaningful progress (different inputs, evolving state, fixing errors)
- **stuck**: Repeating similar actions without progress (same inputs, same errors, no changes)
- **uncertain**: Cannot determine confidently

Consider:
- Are inputs evolving or static?
- Are outputs showing progress or same errors?
- Is the agent exploring or spinning?`;

  const { object } = await generateObject({ model, schema: LoopJudgmentSchema, prompt });

  return object;
}
