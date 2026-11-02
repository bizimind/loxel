/**
 * Java's contribution to terminal environments: the JDK the user chose for the worktree, as
 * `JAVA_HOME` and its `bin` first on PATH. A detected JDK changes nothing here: detection takes the
 * newest JDK and reads no version pins, while the shell's own `java` and `JAVA_HOME` may be what the
 * project builds with. See docs/languages/java.md.
 */
import path from "node:path";

import { getJavaEnv, isJdkInWorktree } from "./java-env";
import { getJavaOverride } from "./java-override-store";
import { isRepoTrusted, reportRepoRestriction } from "./repo-trust";
import {
  putFirstOnPath,
  type TerminalEnvChange,
  type ToolchainEnvContributor,
} from "./toolchain-env-contributor";

const IN_WORKTREE_RESTRICTION = "The JDK chosen inside the worktree doesn't reach new terminals.";

/**
 * Without a choice this runs nothing, so a worktree with no Java in it pays nothing. A choice that
 * no longer qualifies falls through to detection in `java-env.ts`, which refuses a JDK with files
 * git tracks, so only `source: "override"` counts, and a JDK inside an untrusted worktree stays off
 * PATH, tracked or not.
 */
async function resolveChange(worktreePath: string): Promise<TerminalEnvChange | null> {
  if (getJavaOverride(worktreePath) === null) return null;
  const env = await getJavaEnv(worktreePath);
  if (env?.source !== "override") return null;
  const home = env.path;
  // PATH cannot hold it: it would split into other directories.
  if (home.includes(path.delimiter)) return null;
  const bin = path.join(home, "bin");
  // `bin` too: its real path can lie elsewhere than the home's.
  if (
    !isRepoTrusted(worktreePath) &&
    (isJdkInWorktree(home, worktreePath) || isJdkInWorktree(bin, worktreePath))
  ) {
    reportRepoRestriction(worktreePath, IN_WORKTREE_RESTRICTION);
    return null;
  }
  return (spawnEnv) => {
    spawnEnv.JAVA_HOME = home;
    putFirstOnPath(spawnEnv, bin);
  };
}

export const javaToolchainEnv: ToolchainEnvContributor = {
  name: "Java",
  resolveForTerminal: resolveChange,
};
