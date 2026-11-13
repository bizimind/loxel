import { describe, expect, test } from "bun:test";

import { mapToolRequest, type ClaudePermissionUpdate } from "./claude-permissions";

const bashRule: ClaudePermissionUpdate = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
  behavior: "allow",
  destination: "localSettings",
};

describe("mapToolRequest", () => {
  test("AskUserQuestion becomes a question; answers go back as updated input", () => {
    const input = {
      questions: [
        {
          question: "Which color?",
          header: "Color",
          multiSelect: false,
          options: [
            { label: "red", description: "warm" },
            { label: "blue", description: "cool", preview: "# Blue" },
          ],
        },
      ],
    };
    const { interaction, resolve } = mapToolRequest("i1", { toolName: "AskUserQuestion", input });
    expect(interaction).toEqual({
      kind: "question",
      id: "i1",
      questions: [
        {
          question: "Which color?",
          header: "Color",
          multiSelect: false,
          options: [
            { label: "red", description: "warm" },
            { label: "blue", description: "cool", preview: "# Blue" },
          ],
        },
      ],
    });
    expect(resolve({ kind: "question", answers: { "Which color?": "blue" } })).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which color?": "blue" } },
    });
    expect(resolve({ kind: "question", dismissed: true }).behavior).toBe("deny");
  });

  test("approving a plan leaves plan mode for the chosen mode, in the same turn", () => {
    const input = { plan: "1. Do it", planFilePath: "/plans/p.md" };
    const { interaction, resolve } = mapToolRequest("p1", { toolName: "ExitPlanMode", input });
    expect(interaction).toEqual({
      kind: "plan",
      id: "p1",
      plan: "1. Do it",
      planFilePath: "/plans/p.md",
    });
    expect(resolve({ kind: "plan", decision: "approve", mode: "acceptEdits" })).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  });

  test("keep planning sends the feedback back", () => {
    const { resolve } = mapToolRequest("p1", { toolName: "ExitPlanMode", input: { plan: "x" } });
    expect(resolve({ kind: "plan", decision: "keep_planning", feedback: "add tests" })).toEqual({
      behavior: "deny",
      message: "Keep planning. Feedback: add tests",
    });
  });

  test("a permission shows its suggestions as rules, and always-allow saves them where chosen", () => {
    const input = { command: "npm test" };
    const { interaction, resolve } = mapToolRequest("b1", {
      toolName: "Bash",
      input,
      suggestions: [bashRule],
      decisionReason: "no matching rule",
    });
    expect(interaction).toMatchObject({
      kind: "permission",
      toolName: "Bash",
      decisionReason: "no matching rule",
      allowAlways: true,
      suggestions: [
        { id: "0", label: "Bash(npm test:*)", destination: "localSettings", movable: true },
      ],
    });
    expect(
      resolve({
        kind: "permission",
        decision: "allow",
        always: [{ id: "0", destination: "userSettings" }],
      }),
    ).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ ...bashRule, destination: "userSettings" }],
    });
    expect(resolve({ kind: "permission", decision: "allow" })).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  test("deny carries the user's feedback and can stop the turn", () => {
    const { resolve } = mapToolRequest("b1", { toolName: "Bash", input: { command: "rm -rf x" } });
    expect(
      resolve({ kind: "permission", decision: "deny", message: "use trash instead", stop: true }),
    ).toEqual({
      behavior: "deny",
      message: "The user denied this tool call: use trash instead",
      interrupt: true,
    });
  });

  test("no always-allow when the agent's settings forbid remembering it", () => {
    const { interaction, resolve } = mapToolRequest("b1", {
      toolName: "Bash",
      input: {},
      suggestions: [bashRule],
      suppressAlwaysAllowRule: true,
    });
    expect(interaction).toMatchObject({ allowAlways: false, suggestions: [] });
    // Enforced on the server too: a client sending the suggestion's id anyway gets a plain allow.
    expect(resolve({ kind: "permission", decision: "allow", always: [{ id: "0" }] })).toEqual({
      behavior: "allow",
      updatedInput: {},
    });
  });
});
