import type { CanonicalToolName } from "../tools/tool-names.ts";

export type PromptLayer = "base" | "mode" | "tool" | "reminder" | "agent" | "memory";

export interface PromptTemplate {
  name: string;
  description: string;
  version: string;
  layer: PromptLayer;
  visibility: "user-visible" | "system-only";
  trigger: "always" | "conditional";
  tokenBudget: "medium" | "compact";
  variables: string[];
  render: (variables: Record<string, string>) => string;
}

export const baseSystemPrompt: PromptTemplate = {
  name: "system-prompt-main",
  description: "Core execution policy and behavior",
  version: "1.0.0",
  layer: "base",
  visibility: "system-only",
  trigger: "always",
  tokenBudget: "medium",
  variables: ["date"],
  render: ({ date }) =>
    [
      "You are coding-agent running in programmatic protocol mode.",
      "Use tools deliberately, validate assumptions, and keep output concise.",
      `Today is ${date}. Resolve recency-sensitive tasks with explicit dates.`,
      "Do not reference unavailable tools.",
      "When web content is used, include markdown links in a Sources section.",
    ].join("\n"),
};

export const planModePrompt: PromptTemplate = {
  name: "mode-plan",
  description: "Plan mode restrictions and workflow",
  version: "1.0.0",
  layer: "mode",
  visibility: "system-only",
  trigger: "conditional",
  tokenBudget: "compact",
  variables: ["planFilePath"],
  render: ({ planFilePath }) =>
    [
      "Plan mode is active.",
      "Read/search tools are allowed across the workspace.",
      "Only the plan file may be modified by `Edit`/`Write`/`MultiEdit`.",
      "`Bash` is disabled in plan mode.",
      `Plan file path: ${planFilePath}`,
      "Write and maintain the plan in this file and use `ExitPlanMode` for approval.",
    ].join("\n"),
};

export function toolReminderTemplate(toolName: CanonicalToolName): PromptTemplate {
  return {
    name: `tool-${toolName.toLowerCase()}`,
    description: `Usage constraints for ${toolName}`,
    version: "1.0.0",
    layer: "tool",
    visibility: "system-only",
    trigger: "conditional",
    tokenBudget: "compact",
    variables: [],
    render: () =>
      `Tool guidance: prefer \`${toolName}\` when it is the most direct path for this action.`,
  };
}
