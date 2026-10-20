/**
 * Environment variables coding agents set for the commands they run. Variables an ordinary shell
 * can also carry (an editor's integrated terminal, a cloud IDE) are left out, so a user is never
 * mistaken for an agent.
 */
export const CODING_AGENT_ENV_VARS = [
  // Cross-agent convention (GitHub Copilot, v0, Loxel's own agent, ...)
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
