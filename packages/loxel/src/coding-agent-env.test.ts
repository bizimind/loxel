import { describe, expect, test } from "bun:test";

import { isCodingAgent } from "./coding-agent-env";

describe("isCodingAgent", () => {
  test("recognizes the variables coding agents set", () => {
    for (const name of ["CLAUDECODE", "AI_AGENT", "CODEX_SANDBOX", "GEMINI_CLI", "CURSOR_AGENT"]) {
      expect(isCodingAgent({ [name]: "1" })).toBe(true);
    }
  });

  test("a user's shell is not an agent, even inside an editor or with a blank variable", () => {
    expect(isCodingAgent({ HOME: "/home/me", TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" })).toBe(
      false,
    );
    expect(isCodingAgent({ CLAUDECODE: "", AI_AGENT: " " })).toBe(false);
  });
});
