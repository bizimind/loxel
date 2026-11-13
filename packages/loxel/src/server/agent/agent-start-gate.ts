/**
 * Whether an agent may start in a directory. Claude Code's print mode, which the SDK runs, skips
 * the TUI's "trust this folder" prompt, so a repository's project settings, hooks and MCP servers
 * would run unasked; Loxel's own repository trust decides instead, as it does for language
 * tooling.
 */
import { stat } from "node:fs/promises";

import { isRepoTrusted, reportRepoRestriction } from "../repo-trust";

const RESTRICTION = "Claude Code agents don't start";

export async function agentStartGate(cwd: string): Promise<string | null> {
  const isDirectory = await stat(cwd).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDirectory) return `The folder ${cwd} no longer exists.`;
  if (isRepoTrusted(cwd)) return null;
  reportRepoRestriction(cwd, RESTRICTION);
  return "Claude Code would run this repository's project settings, hooks and MCP servers, and you haven't trusted it. Trust the repository, then start again.";
}
