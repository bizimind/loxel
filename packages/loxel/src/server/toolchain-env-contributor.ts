/**
 * What one toolchain adds to the environment of new terminal shells. Contributors are listed in
 * `toolchain-envs.ts`. See docs/TERMINALS.md.
 */
import path from "node:path";

import { logger } from "./logger";

const log = logger.child("server");

export type SpawnEnv = Record<string, string | undefined>;

/** Changes a new shell's environment. Unlike the resolution before it, this is not timed out. */
export type TerminalEnvChange = (env: SpawnEnv, shell: string) => void | Promise<void>;

/** Settings of a terminal spawn request that switch a toolchain's activation off. */
export interface TerminalToolchainSettings {
  /** Activate the worktree's Python environment; defaults to true. Applied only when spawned. */
  activatePythonEnv?: boolean;
}

/**
 * One toolchain's contribution. A directory it puts on PATH runs ahead of the user's commands, so
 * it must refuse one holding files git tracks in the worktree. {@link commitToolchainEnvChange}
 * checks the characters in the path itself.
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
}

/**
 * /etc/profile and /etc/zprofile `eval` the output of macOS `path_helper`, which prints PATH in
 * double quotes, so these characters in a PATH entry would be interpreted by the shell. Branch
 * names (and so worktree directories) may contain them. Not checked on Windows, whose paths are
 * full of backslashes and whose shells run no such startup.
 */
const SHELL_EVAL_CHARS = /["$`\\]/;
const IS_WINDOWS = process.platform === "win32";

/** New shells keep hitting a refused directory, so each one is logged once. */
const loggedRefusals = new Set<string>();

function pathEntries(env: SpawnEnv): string[] {
  return (env.PATH ?? "").split(path.delimiter);
}

/** The directories `changed` adds to PATH or moves forward that a shell would interpret. */
function refusedPathEntries(env: SpawnEnv, changed: SpawnEnv): string[] {
  if (IS_WINDOWS) return [];
  const before = pathEntries(env);
  const after = pathEntries(changed);
  return after.filter((dir, index) => {
    if (!SHELL_EVAL_CHARS.test(dir)) return false;
    const previous = before.indexOf(dir);
    if (previous === -1) return true;
    // Moved forward: an entry it used to follow now comes after it. Its plain index also shifts
    // when an entry ahead of it is added or removed.
    return after.slice(index + 1).some((other) => {
      const otherPrevious = before.indexOf(other);
      return otherPrevious !== -1 && otherPrevious < previous;
    });
  });
}

/**
 * Apply one contribution, made on a copy of `env`: `env` becomes `changed`, or stays as it is, whole,
 * when the contribution puts a path on PATH that fails the check. Every caller that applies a
 * contributor's change goes through this, so the check covers each toolchain the same way.
 */
export function commitToolchainEnvChange(env: SpawnEnv, changed: SpawnEnv): void {
  const refused = refusedPathEntries(env, changed);
  if (refused.length > 0) {
    for (const dir of refused) {
      if (loggedRefusals.has(dir)) continue;
      loggedRefusals.add(dir);
      log.warn("Not activating a toolchain environment whose path the shell would interpret", {
        dir,
      });
    }
    return;
  }
  for (const name of Object.keys(env)) {
    if (!(name in changed)) delete env[name];
  }
  Object.assign(env, changed);
}
