/**
 * Go's contribution to terminal environments: the `bin` of a Go the user chose for
 * the worktree, first on PATH. Detection changes nothing here, cached toolchains included, since a
 * terminal's `go` switches by itself. `GO_ENV` stays out: `go` in a terminal is the user's own, and
 * is how they download. See docs/languages/go.md.
 */
import path from "node:path";

import type { GoEnv } from "@/api/go-env-model";

import { getGoEnv } from "./go-env";
import { getGoChoice } from "./go-toolchain-store";
import type {
  SpawnEnv,
  TerminalEnvChange,
  ToolchainEnvContributor,
} from "./toolchain-env-contributor";

/** The chosen Go's `bin`. `go-env.ts` refuses a chosen Go in the worktree or tracked by git. */
function chosenBin(env: GoEnv | null): string | null {
  return env?.source === "chosen" && env.goroot ? path.join(env.goroot, "bin") : null;
}

function putFirstOnPath(env: SpawnEnv, bin: string): void {
  const rest = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && dir !== bin);
  env.PATH = [bin, ...rest].join(path.delimiter);
}

function changeFor(env: GoEnv | null): TerminalEnvChange | null {
  const bin = chosenBin(env);
  if (!bin) return null;
  return (spawnEnv) => {
    putFirstOnPath(spawnEnv, bin);
  };
}

/** Without a choice this runs nothing, so a worktree with no Go in it pays nothing. */
async function resolveChange(worktreePath: string): Promise<TerminalEnvChange | null> {
  return getGoChoice(worktreePath) === null ? null : changeFor(await getGoEnv(worktreePath));
}

export const goToolchainEnv: ToolchainEnvContributor = {
  name: "Go",
  resolveForTerminal: resolveChange,
};
