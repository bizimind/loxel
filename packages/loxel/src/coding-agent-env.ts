/**
 * Environment variables coding agents set for the commands they run. Variables an ordinary shell
 * can also carry (an editor's integrated terminal, a cloud IDE) are left out, so a user is never
 * mistaken for an agent.
 */
export const CODING_AGENT_ENV_VARS = [
  // Cross-agent convention (GitHub Copilot, v0, ...)
  "AI_AGENT",
  // Claude Code
  "CLAUDECODE",
  "CLAUDE_CODE",
  // OpenAI Codex
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  // Gemini CLI
  "GEMINI_CLI",
  // Cursor's agent
  "CURSOR_AGENT",
  // opencode
  "OPENCODE_CLIENT",
  // Augment
  "AUGMENT_AGENT",
  // Antigravity
  "ANTIGRAVITY_AGENT",
] as const;

/** Whether a process was started by a coding agent rather than by the user, from its env. */
export function isCodingAgent(env: Record<string, string | undefined>): boolean {
  return CODING_AGENT_ENV_VARS.some((name) => (env[name] ?? "").trim() !== "");
}

/**
 * Session markers beyond CODING_AGENT_ENV_VARS: what an agent, or a Loxel terminal, hands the
 * commands it runs to tie them to its session (its IDE socket, session ID, sandbox, server port).
 */
const SESSION_ENV_VARS = [
  // Claude Code
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  // OpenAI Codex
  "CODEX_SANDBOX_NETWORK_DISABLED",
  // A Loxel terminal (src/server/server.ts gives its shells these)
  "LOXEL",
  "LOXEL_PORT",
  "LOXEL_WORKTREE",
  "LOXEL_WINDOW_ID",
];

/**
 * `env` without what would make a process think it runs inside an agent's session or a Loxel
 * terminal, for a Loxel server started from one (a test server, a demo app): its terminals, and
 * the agents started in them, must start sessions of their own. Auth and configuration stay
 * (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `CODEX_HOME`, `OPENAI_*`, ...),
 * so those agents still sign in and behave as the user set them up. Unset values are dropped.
 */
export function withoutAgentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const removed = new Set<string>([...CODING_AGENT_ENV_VARS, ...SESSION_ENV_VARS]);
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !removed.has(key)) kept[key] = value;
  }
  return kept;
}
