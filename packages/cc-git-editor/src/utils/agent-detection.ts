/**
 * Agent mode detection
 *
 * Checks if we're running in Claude Code agent mode.
 */

export function isAgentMode(): boolean {
  // Claude Code sets CLAUDECODE=1
  return process.env.CLAUDECODE === "1";
}
