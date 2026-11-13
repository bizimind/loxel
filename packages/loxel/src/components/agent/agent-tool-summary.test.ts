import { describe, expect, test } from "bun:test";

import { toolSummary } from "./agent-tool-summary";
import { matchingCommands } from "./AgentComposer";

describe("toolSummary", () => {
  const paths = { root: "/Users/dev/project", home: "/Users/dev" };

  test("names what a call does, with paths shortened to the worktree or home", () => {
    expect(toolSummary("Bash", { command: "npm test\n--watch" })).toBe("npm test");
    expect(toolSummary("Read", { file_path: "/Users/dev/project/src/a.ts" }, paths)).toBe(
      "src/a.ts",
    );
    expect(toolSummary("Write", { file_path: "/Users/dev/.claude/plans/p.md" }, paths)).toBe(
      "~/.claude/plans/p.md",
    );
    expect(toolSummary("SomeMcpTool", { query: "x" })).toBe("x");
    expect(toolSummary("Bash", null)).toBe("");
  });
});

describe("matchingCommands", () => {
  const commands = [
    { name: "review", description: "", argumentHint: "" },
    { name: "code-review", description: "", argumentHint: "" },
    { name: "compact", description: "", argumentHint: "" },
  ];

  test("lists commands while the first word is typed, prefix matches first", () => {
    expect(matchingCommands("/rev", commands).map((c) => c.name)).toEqual([
      "review",
      "code-review",
    ]);
    expect(matchingCommands("/review now", commands)).toEqual([]);
    expect(matchingCommands("review", commands)).toEqual([]);
  });
});
