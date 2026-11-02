/**
 * Python's contribution to terminal environments, from the worktree's shared
 * resolution. See docs/languages/python.md.
 */
import { getPythonEnv } from "./python-env";
import { activatePythonEnv } from "./terminal-python-env";
import type { ToolchainEnvContributor } from "./toolchain-env-contributor";

export const pythonToolchainEnv: ToolchainEnvContributor = {
  name: "Python",
  enabledInTerminal: (settings) => settings.activatePythonEnv !== false,
  resolveForTerminal: async (worktreePath) => {
    const pythonEnv = await getPythonEnv(worktreePath);
    return pythonEnv && ((env, shell) => activatePythonEnv(env, pythonEnv, shell, worktreePath));
  },
};
