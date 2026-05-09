import type { PromptTemplate } from "./templates.ts";

import { CANONICAL_TOOLS } from "../tools/tool-names.ts";

const placeholderPattern = /\$\{[^}]+\}/g;
const toolMentionPattern = /`([A-Za-z][A-Za-z0-9]+)`/g;

export interface PromptValidationIssue {
  code: "UNRESOLVED_PLACEHOLDER" | "UNKNOWN_TOOL_REFERENCE";
  template: string;
  message: string;
}

export interface PromptValidationResult {
  ok: boolean;
  issues: PromptValidationIssue[];
}

export function validatePromptRender(
  template: PromptTemplate,
  rendered: string,
  availableTools: readonly string[] = CANONICAL_TOOLS,
): PromptValidationResult {
  const issues: PromptValidationIssue[] = [];

  const unresolved = rendered.match(placeholderPattern) ?? [];
  for (const placeholder of unresolved) {
    issues.push({
      code: "UNRESOLVED_PLACEHOLDER",
      template: template.name,
      message: `Unresolved placeholder ${placeholder} in rendered prompt`,
    });
  }

  const knownTools = new Set(availableTools);
  const matches = rendered.matchAll(toolMentionPattern);
  for (const match of matches) {
    const mention = match[1];
    if (!mention) {
      continue;
    }
    if (mention.endsWith("Mode")) {
      continue;
    }
    if (!knownTools.has(mention) && mention !== "LS") {
      issues.push({
        code: "UNKNOWN_TOOL_REFERENCE",
        template: template.name,
        message: `Unknown tool reference \`${mention}\` in rendered prompt`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}
