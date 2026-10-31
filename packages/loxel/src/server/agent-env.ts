/**
 * The environment of the built-in coding agent's tool subprocesses (Bash, Grep, background tasks):
 * the login-shell spawn environment, marked as an agent's, with the worktree's toolchains activated
 * and kept current as they re-resolve. See docs/CODING_AGENT_INTEGRATION.md.
 */
import path from "node:path";

import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";
import type { EnvChange, SpawnEnv, ToolchainEnvContributor } from "./toolchain-env-contributor";
import { toolchainEnvs } from "./toolchain-envs";

const log = logger.child("agent");

/**
 * The agent's environment: the spawn environment as it is now, `AI_AGENT=loxel` (the cross-agent
 * marker that tells tools such as the `loxel` CLI an agent ran them), and `changes` applied in
 * order.
 */
export function buildAgentEnv(changes: Iterable<EnvChange | null>): SpawnEnv {
  const env: SpawnEnv = { ...buildSpawnEnv(), AI_AGENT: "loxel" };
  for (const change of changes) {
    try {
      change?.(env);
    } catch (err) {
      log.warn("Could not apply a toolchain's environment for the agent", { error: err });
    }
  }
  return env;
}

/**
 * One agent session's environment, following each toolchain's resolution: starts without a
 * toolchain's environment rather than waiting for it, applies its last finished resolution when it
 * lands, and every one after it (a `uv sync` that created `.venv`, a pick in the interpreter picker,
 * an environment that now fails the trust rule). A workspace root that is not an absolute path (no
 * worktree) gets no toolchain environment.
 */
export class AgentEnv {
  /** Keyed in contribution order, which setting a key keeps. */
  private readonly changes: Map<ToolchainEnvContributor, EnvChange | null>;
  private readonly unsubscribes: (() => void)[] = [];
  private disposed = false;
  /**
   * A toolchain's resolutions apply one at a time, in the order they were heard, so the latest one
   * wins; a slow toolchain holds up only its own.
   */
  private readonly updating = new Map<ToolchainEnvContributor, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    contributors: readonly ToolchainEnvContributor[] = toolchainEnvs,
  ) {
    this.changes = new Map(contributors.map((contributor) => [contributor, null]));
    if (!path.isAbsolute(workspaceRoot)) return;
    for (const contributor of contributors) {
      try {
        this.follow(contributor);
      } catch (err) {
        log.warn(`Could not follow the ${contributor.name} environment for the agent`, {
          workspaceRoot,
          error: err,
        });
      }
    }
  }

  /**
   * The environment for the next spawn; pass as `SessionConfig.env`. Built at each call, so a
   * login-shell environment captured after the session started applies too.
   */
  readonly get = (): SpawnEnv => buildAgentEnv(this.changes.values());

  /** Settles once every resolution heard so far, including the initial answer, has been applied. */
  async settled(): Promise<void> {
    for (const contributor of this.updating.keys()) {
      let updating: Promise<void> | undefined;
      do {
        updating = this.updating.get(contributor);
        await updating;
      } while (updating !== this.updating.get(contributor));
    }
  }

  /** Stop following the resolutions; the current environment stays. */
  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private follow(contributor: ToolchainEnvContributor): void {
    let heard = false;
    this.unsubscribes.push(
      contributor.subscribeForAgent(this.workspaceRoot, (resolve) => {
        heard = true;
        const previous = this.updating.get(contributor);
        this.updating.set(
          contributor,
          (previous ?? Promise.resolve()).then(() => this.apply(contributor, resolve)),
        );
      }),
    );
    this.updating.set(
      contributor,
      this.apply(
        contributor,
        () => contributor.resolveForAgent(this.workspaceRoot),
        // A resolution heard meanwhile is at least as new.
        () => heard,
      ),
    );
  }

  private async apply(
    contributor: ToolchainEnvContributor,
    resolve: () => Promise<EnvChange | null>,
    isSuperseded: () => boolean = () => false,
  ): Promise<void> {
    try {
      const change = await resolve();
      if (!this.disposed && !isSuperseded()) this.changes.set(contributor, change);
    } catch (err) {
      log.warn(`Could not activate the ${contributor.name} environment for the agent`, {
        workspaceRoot: this.workspaceRoot,
        error: err,
      });
    }
  }
}
