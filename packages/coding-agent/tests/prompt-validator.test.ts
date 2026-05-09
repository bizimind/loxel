import { describe, expect, test } from "bun:test";

import { planModePrompt } from "../src/prompts/templates.ts";
import { validatePromptRender } from "../src/prompts/validator.ts";

describe("prompt validator", () => {
  test("flags unresolved placeholders", () => {
    const result = validatePromptRender(planModePrompt, "Path: ${planFilePath}");
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "UNRESOLVED_PLACEHOLDER")).toBe(true);
  });

  test("flags unknown backtick tool references", () => {
    const result = validatePromptRender(planModePrompt, "Use `UnknownTool` now.");
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "UNKNOWN_TOOL_REFERENCE")).toBe(true);
  });
});
