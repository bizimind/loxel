/**
 * What one toolchain adds to the environment of new terminal shells and of the built-in coding
 * agent's tool subprocesses. Contributors are listed in `toolchain-envs.ts`. See
 * docs/TERMINALS.md and docs/CODING_AGENT_INTEGRATION.md.
 */

export type SpawnEnv = Record<string, string | undefined>;

/** Changes a spawn environment; runs on every agent spawn, so it must be synchronous. */
export type EnvChange = (env: SpawnEnv) => undefined;

/** Changes a new shell's environment. Unlike the resolution before it, this is not timed out. */
export type TerminalEnvChange = (env: SpawnEnv, shell: string) => void | Promise<void>;

/** Settings of a terminal spawn request that switch a toolchain's activation off. */
export interface TerminalToolchainSettings {
  /** Activate the worktree's Python environment; defaults to true. Applied only when spawned. */
  activatePythonEnv?: boolean;
}

/**
 * One toolchain's contribution. A directory it puts on PATH runs ahead of the user's commands, so
 * it must refuse what Python's activation refuses: a path holding characters a login shell would
 * interpret (`path_helper`'s PATH is `eval`ed at startup, and a worktree's path comes from its
 * branch name), and a directory holding files git tracks in the worktree.
 */
export interface ToolchainEnvContributor {
  /** The toolchain's name in logs. */
  name: string;
  /** Whether a terminal's settings leave this toolchain on; without this, always. */
  enabledInTerminal?: (settings: TerminalToolchainSettings) => boolean;
  /**
   * What a new shell in this worktree gets, or null for nothing. A shell waits a few seconds for
   * this, then starts without it. Login shells can reorder PATH during startup, so a PATH entry
   * set here is not guaranteed to stay first.
   */
  resolveForTerminal: (worktreePath: string) => Promise<TerminalEnvChange | null>;
  /** What the agent's commands in this worktree get now, or null. A session does not wait for it. */
  resolveForAgent: (workspaceRoot: string) => Promise<EnvChange | null>;
  /**
   * Calls `listener` whenever the answer of `resolveForAgent` changes, with what resolves the new
   * answer. Calls resolve one at a time, in the order heard. Returns the unsubscribe function.
   */
  subscribeForAgent: (
    workspaceRoot: string,
    listener: (resolve: () => Promise<EnvChange | null>) => void,
  ) => () => void;
}
