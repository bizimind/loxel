import { tool, type ToolSet } from "ai";

import type { ToolPolicyViolationResult } from "../core/errors.ts";
import { intersectWithDeclared } from "./capabilities.ts";
import type { ToolRuntimeContext } from "./context.ts";
import { invokeToolByName } from "./handlers.ts";
import { getAllowedToolsForProfile } from "./profile.ts";
import { toolSchemas } from "./schemas.ts";

export function createAiToolSet(ctx: ToolRuntimeContext): ToolSet {
  const allowedTools = intersectWithDeclared(
    getAllowedToolsForProfile(ctx.profile),
    ctx.declaredTools ?? null,
  );

  const entries = allowedTools.map((toolName) => {
    const schema = toolSchemas[toolName];

    return [
      toolName,
      tool({
        description: `coding-agent tool ${toolName}`,
        inputSchema: schema.input,
        execute: async (input: unknown) => {
          const result = await invokeToolByName(toolName, input, ctx);
          if (!result.ok) {
            // Policy violations are reported as tool results (isError: true)
            // so the model can see and react to the policy feedback.
            // Other errors throw, letting the SDK handle retry/recovery.
            if (result.error.code === "TOOL_POLICY_VIOLATION") {
              return {
                _type: "policy_violation",
                code: result.error.code,
                message: result.error.message,
                suggested_fix: result.error.suggested_fix,
              } satisfies ToolPolicyViolationResult;
            }
            throw new Error(`${result.error.code}: ${result.error.message}`);
          }
          return result.value;
        },
      }),
    ] as const;
  });

  return Object.fromEntries(entries) as ToolSet;
}
