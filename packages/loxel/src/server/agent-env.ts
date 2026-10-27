/**
 * The environment of the built-in coding agent's tool subprocesses (Bash, Grep, background tasks):
 * the login-shell spawn environment, marked as an agent's, with the worktree's Python environment
 * activated and kept current as it re-resolves. See docs/CODING_AGENT_INTEGRATION.md.
 */
import path from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

import { logger } from "./logger";
import { getPythonEnvNow, subscribePythonEnv } from "./python-env";
import { pythonEnvActivation, setPythonEnvVars } from "./python-env-activation";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("agent");

type Env = Record<string, string | undefined>;

/**
 * The spawn environment plus `AI_AGENT=loxel`, the cross-agent marker that tells tools such as the
 * `loxel` CLI an agent ran them.
 */
function baseAgentEnv(): Env {
  return { ...buildSpawnEnv(), AI_AGENT: "loxel" };
}

/**
 * The agent's environment with `pythonEnv` activated like a terminal's. The agent's commands run
 * in a non-login shell, which leaves PATH as given, so a venv also gets `VIRTUAL_ENV` without the
 * zsh shim terminals need.
 */
export async function buildAgentEnv(
  workspaceRoot: string,
  pythonEnv: PythonEnv | null,
): Promise<Env> {
  const env = baseAgentEnv();
  if (!pythonEnv) return env;
  const activation = await pythonEnvActivation(pythonEnv, workspaceRoot);
  if (activation) setPythonEnvVars(env, activation, { virtualEnv: true });
  return env;
}

/**
 * One agent session's environment, following the workspace's shared Python resolution: starts
 * without the Python environment rather than waiting for it, applies the last finished resolution
 * when it lands, and each one that changes the interpreter or override after it (a `uv sync` that
 * created `.venv`, a pick in the interpreter picker). A workspace root that is not an absolute
 * path (no worktree) gets no Python environment.
 */
export class AgentEnv {
  private env: Env = baseAgentEnv();
  private unsubscribe: (() => void) | null = null;
  /** Resolutions apply one at a time, in the order they were heard, so the latest one wins. */
  private updating: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    if (!path.isAbsolute(workspaceRoot)) return;
    let heard = false;
    this.unsubscribe = subscribePythonEnv(workspaceRoot, ({ env, changed }) => {
      // The first one heard is applied even when unchanged: the initial answer below defers to it.
      if (changed || !heard) this.updating = this.updating.then(() => this.apply(env));
      heard = true;
    });
    this.updating = getPythonEnvNow(workspaceRoot).then(
      (env) => (heard ? undefined : this.apply(env)),
      (err: unknown) => {
        log.warn("Could not resolve the Python environment for the agent", {
          workspaceRoot,
          error: err,
        });
      },
    );
  }

  /** The environment for the next spawn; pass as `SessionConfig.env`. */
  readonly get = (): Env => this.env;

  /** Settles once every resolution heard so far, including the initial answer, has been applied. */
  async settled(): Promise<void> {
    let updating: Promise<void>;
    do {
      updating = this.updating;
      await updating;
    } while (updating !== this.updating);
  }

  /** Stop following the resolution; the current environment stays. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async apply(pythonEnv: PythonEnv | null): Promise<void> {
    try {
      const env = await buildAgentEnv(this.workspaceRoot, pythonEnv);
      if (this.unsubscribe) this.env = env;
    } catch (err) {
      log.warn("Could not activate the Python environment for the agent", {
        workspaceRoot: this.workspaceRoot,
        error: err,
      });
    }
  }
}
