/**
 * The environment of the built-in coding agent's tool subprocesses (Bash, Grep, background tasks):
 * the login-shell spawn environment, marked as an agent's, with the worktree's Python environment
 * activated and kept current as it re-resolves. See docs/CODING_AGENT_INTEGRATION.md.
 */
import path from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

import { logger } from "./logger";
import { getPythonEnvNow, subscribePythonEnv } from "./python-env";
import {
  type PythonEnvActivation,
  pythonEnvActivation,
  setPythonEnvVars,
} from "./python-env-activation";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("agent");

type Env = Record<string, string | undefined>;

/**
 * The agent's environment: the spawn environment as it is now, `AI_AGENT=loxel` (the cross-agent
 * marker that tells tools such as the `loxel` CLI an agent ran them), and `activation` applied like
 * a terminal's. The agent's commands run in a non-login `$SHELL -c`, which skips the login startup
 * that reorders a terminal's PATH, so a venv also gets `VIRTUAL_ENV` without the zsh shim. A shell's
 * non-login startup (zsh's `.zshenv`, fish's `config.fish`) can still put directories ahead of the
 * environment's `bin`; see issue #776.
 */
export function buildAgentEnv(activation: PythonEnvActivation | null): Env {
  const env: Env = { ...buildSpawnEnv(), AI_AGENT: "loxel" };
  if (activation) setPythonEnvVars(env, activation, { virtualEnv: true });
  return env;
}

/**
 * One agent session's environment, following the workspace's shared Python resolution: starts
 * without the Python environment rather than waiting for it, applies the last finished resolution
 * when it lands, and every one after it (a `uv sync` that created `.venv`, a pick in the
 * interpreter picker, an environment that now fails the trust rule). A workspace root that is not
 * an absolute path (no worktree) gets no Python environment.
 */
export class AgentEnv {
  private activation: PythonEnvActivation | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Resolutions apply one at a time, in the order they were heard, so the latest one wins. */
  private updating: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    if (!path.isAbsolute(workspaceRoot)) return;
    let heard = false;
    this.unsubscribe = subscribePythonEnv(workspaceRoot, ({ env }) => {
      heard = true;
      this.updating = this.updating.then(() => this.apply(env));
    });
    this.updating = getPythonEnvNow(workspaceRoot).then(
      // A resolution heard meanwhile is at least as new.
      (env) => (heard ? undefined : this.apply(env)),
      (err: unknown) => {
        log.warn("Could not resolve the Python environment for the agent", {
          workspaceRoot,
          error: err,
        });
      },
    );
  }

  /**
   * The environment for the next spawn; pass as `SessionConfig.env`. Built at each call, so a
   * login-shell environment captured after the session started applies too.
   */
  readonly get = (): Env => buildAgentEnv(this.activation);

  /** Settles once every resolution heard so far, including the initial answer, has been applied. */
  async settled(): Promise<void> {
    let updating: Promise<void>;
    do {
      updating = this.updating;
      await updating;
    } while (updating !== this.updating);
  }

  /** Stop following the resolution; the current activation stays. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async apply(pythonEnv: PythonEnv | null): Promise<void> {
    try {
      const activation = pythonEnv
        ? await pythonEnvActivation(pythonEnv, this.workspaceRoot)
        : null;
      if (this.unsubscribe) this.activation = activation;
    } catch (err) {
      log.warn("Could not activate the Python environment for the agent", {
        workspaceRoot: this.workspaceRoot,
        error: err,
      });
    }
  }
}
