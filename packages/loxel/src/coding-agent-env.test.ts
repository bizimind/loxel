import { describe, expect, test } from "bun:test";

import { isCodingAgent, withoutAgentEnv } from "./coding-agent-env";

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

describe("withoutAgentEnv", () => {
  test("drops agent and Loxel session markers, keeps auth and config", () => {
    const env = withoutAgentEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "1234",
      CODEX_THREAD_ID: "t",
      CODEX_SANDBOX: "seatbelt",
      LOXEL: "1",
      LOXEL_PORT: "7433",
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_API_KEY: "key",
      CODEX_HOME: "/x",
      OPENAI_API_KEY: "key",
      PATH: "/bin",
      UNSET: undefined,
    });
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_API_KEY: "key",
      CODEX_HOME: "/x",
      OPENAI_API_KEY: "key",
      PATH: "/bin",
    });
  });
});
