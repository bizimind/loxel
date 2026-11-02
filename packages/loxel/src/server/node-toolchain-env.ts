/**
 * Node's contribution to terminal environments. See docs/languages/javascript.md.
 */
import path from "node:path";

import type { NodeEnv } from "@/api/node-env-model";

import { logger } from "./logger";
import { resolveNodeEnv } from "./node-env";
import { isShippedByRepo } from "./shipped-by-repo";
import type { TerminalEnvChange, ToolchainEnvContributor } from "./toolchain-env-contributor";

const log = logger.child("server");

/**
 * What using `nodeEnv` changes in a spawn environment: a pinned or chosen Node's `bin` first on
 * PATH, moved rather than duplicated. Null when it is simply the `PATH` `node`, found or picked (the
 * picker offers it under no manager): its directory may be `/usr/bin` or a shim directory, and
 * moving that would reorder every other command. Null too when that `bin` holds files git tracks:
 * first on PATH, a committed `bin/git` beside `node` would shadow the real one, a wider question than
 * the resolver's about `node` alone.
 */
async function nodeEnvChange(
  nodeEnv: NodeEnv | null,
  worktreePath: string,
): Promise<TerminalEnvChange | null> {
  if (!nodeEnv || nodeEnv.source === "system" || nodeEnv.manager === null) return null;
  const binDir = path.dirname(nodeEnv.nodePath);
  if (await isShippedByRepo(worktreePath, binDir)) {
    log.warn("Not putting a Node directory with files tracked by git on PATH", { binDir });
    return null;
  }
  return (env) => {
    const rest = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && dir !== binDir);
    env.PATH = [binDir, ...rest].join(path.delimiter);
  };
}

export const nodeToolchainEnv: ToolchainEnvContributor = {
  name: "Node",
  // Every new shell asks, in any repository, so this answer runs no `node`, unlike the shared one.
  resolveForTerminal: async (worktreePath) => {
    const { env } = await resolveNodeEnv(worktreePath, { selectedOnly: true });
    return nodeEnvChange(env, worktreePath);
  },
};
