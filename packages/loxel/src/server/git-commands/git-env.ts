import { isRepoTrusted } from "../repo-trust";

/**
 * Environment and shared arguments for git invocations.
 *
 * These live in their own module rather than in `validation.ts` so there is exactly one source
 * of truth for how Loxel shells out to git, independent of argument validation.
 */

// Loxel never passes `core.fsmonitor=true`: under GIT_OPTIONAL_LOCKS=0 it can't save its token, and
// it would leave a daemon behind for every worktree and submodule. Whether fsmonitor runs on a read
// is the user's Git configuration in a trusted repository; everywhere else it is off.

/**
 * The setting as an argument, placed before the subcommand, for the checks that decide what Loxel
 * runs, in any repository: `git -c` works in every git, while `GIT_CONFIG_COUNT` needs git 2.31.
 */
export const FSMONITOR_OFF = ["-c", "core.fsmonitor=false"];

/**
 * Global options for every command that compares the working tree (status, working-tree diffs).
 * Placed before the subcommand: `git -C <dir> ${SUBMODULE_GITLINK_ONLY} status ...`.
 *
 * Git otherwise decides whether each submodule is dirty by running a status inside it,
 * recursively, which dominates the cost in repositories with many submodules (4s against 0.3s
 * for one with 76). With it a submodule shows as changed only when its checked-out commit
 * differs from the recorded one; edits and untracked files inside it are not reported. A
 * design decision: Loxel reports submodules at the gitlink level only.
 *
 * Set as the `diff.ignoreSubmodules` default rather than passed as `--ignore-submodules=dirty`:
 * the flag would override a repository's own `submodule.<name>.ignore` (an `all` submodule would
 * reappear when its commit moves), whereas per-submodule configuration takes precedence over
 * this default.
 */
export const SUBMODULE_GITLINK_ONLY = ["-c", "diff.ignoreSubmodules=dirty"];

/**
 * Environment for read-only git commands.
 *
 * `GIT_OPTIONAL_LOCKS=0` breaks a feedback loop with the git-directory FileWatcher. A read-only
 * `git status` still refreshes the index and writes `index.lock` on *every* invocation; the
 * watcher classifies that as an index change and asks for another status, once per subscribed
 * worktree, forever. With this variable set the read paths produce no writes in the git dir at
 * all. Git ignores it wherever the lock is mandatory, so it is a no-op for mutating commands —
 * but it is only set here, on the read-only modules, to keep that guarantee explicit.
 *
 * `core.fsmonitor=false` is set here as well, through git's `GIT_CONFIG_*` variables, so every
 * read-only command has it in one place, unless `cwd` is in a trusted repository, whose fsmonitor
 * stays the user's choice. Without a `cwd` it is always set. Its precedence is that of `git -c`, and
 * any such variables already in the environment are kept.
 *
 * Returned as a fresh object because a spawn's `env` REPLACES the child environment instead of
 * merging into it: without spreading `process.env` git would lose `PATH`/`HOME` and fail in ways
 * that no unit test observes.
 */
export function readOnlyGitEnv(cwd?: string): Record<string, string> {
  const env = inheritedGitEnv();
  if (cwd !== undefined && isRepoTrusted(cwd)) return { ...env, GIT_OPTIONAL_LOCKS: "0" };
  const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10) || 0;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${index}`]: "false",
  };
}

/** The server's current environment, for commands with no special needs. */
export function inheritedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
