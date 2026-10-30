/**
 * Python's contribution to terminal and coding-agent environments, from the worktree's shared
 * resolution. See docs/languages/python.md.
 */
import type { PythonEnv } from "@/api/python-env-model";

import { getPythonEnv, getPythonEnvNow, subscribePythonEnv } from "./python-env";
import { pythonEnvActivation, setPythonEnvVars } from "./python-env-activation";
import { activatePythonEnv } from "./terminal-python-env";
import type { EnvChange, ToolchainEnvContributor } from "./toolchain-env-contributor";

/**
 * What activating `pythonEnv` changes in the agent's environment, like a terminal's. The agent's
 * commands run in a non-login `$SHELL -c`, which skips the login startup that reorders a terminal's
 * PATH, so a venv also gets `VIRTUAL_ENV` without the zsh shim. A shell's non-login startup (zsh's
 * `.zshenv`, fish's `config.fish`) can still put directories ahead of the environment's `bin`; see
 * issue #776.
 */
export async function pythonAgentEnvChange(
  pythonEnv: PythonEnv | null,
  workspaceRoot: string,
): Promise<EnvChange | null> {
  const activation = pythonEnv ? await pythonEnvActivation(pythonEnv, workspaceRoot) : null;
  if (!activation) return null;
  return (env) => {
    setPythonEnvVars(env, activation, { virtualEnv: true });
  };
}

export const pythonToolchainEnv: ToolchainEnvContributor = {
  name: "Python",
  enabledInTerminal: (settings) => settings.activatePythonEnv !== false,
  resolveForTerminal: async (worktreePath) => {
    const pythonEnv = await getPythonEnv(worktreePath);
    return pythonEnv && ((env, shell) => activatePythonEnv(env, pythonEnv, shell, worktreePath));
  },
  resolveForAgent: async (workspaceRoot) =>
    pythonAgentEnvChange(await getPythonEnvNow(workspaceRoot), workspaceRoot),
  subscribeForAgent: (workspaceRoot, listener) =>
    subscribePythonEnv(workspaceRoot, ({ env }) => {
      listener(() => pythonAgentEnvChange(env, workspaceRoot));
    }),
};
