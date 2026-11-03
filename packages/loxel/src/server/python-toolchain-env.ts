/**
 * Python's contribution to terminal environments, from the worktree's shared
 * resolution. See docs/languages/python.md.
 */
import { getPythonEnv } from "./python-env";
import { isRepoTrusted, reportRepoRestriction } from "./repo-trust";
import { activatePythonEnv } from "./terminal-python-env";
import type { ToolchainEnvContributor } from "./toolchain-env-contributor";

/** Exported for tests. */
export const TERMINAL_PYTHON_ENV_RESTRICTION =
  "New terminals don't activate the project's Python environment.";

export const pythonToolchainEnv: ToolchainEnvContributor = {
  name: "Python",
  enabledInTerminal: (settings) => settings.activatePythonEnv !== false,
  // An environment holds the project's dependencies, and first on PATH its commands would run in
  // place of the user's own, including ones the shell's startup runs; so only a trusted repository
  // activates it, as only an allowed directory gets its environment under direnv.
  resolveForTerminal: async (worktreePath) => {
    const pythonEnv = await getPythonEnv(worktreePath);
    if (!pythonEnv?.envPath) return null;
    if (!isRepoTrusted(worktreePath)) {
      reportRepoRestriction(worktreePath, TERMINAL_PYTHON_ENV_RESTRICTION);
      return null;
    }
    return (env, shell) => activatePythonEnv(env, pythonEnv, shell, worktreePath);
  },
};
