/**
 * Environment and shared arguments for git invocations.
 *
 * These live in their own module rather than in `validation.ts` so there is exactly one source
 * of truth for how Loxel shells out to git, independent of argument validation.
 */

// Loxel deliberately does NOT pass `-c core.fsmonitor=true`. Forcing it bought nothing: read-only
// commands run with GIT_OPTIONAL_LOCKS=0 (below), so git can never persist the fsmonitor token
// in the index and every query gets a "trivial" response followed by a full lstat scan. It cost an
// IPC round trip per command and left a persistent `fsmonitor--daemon` behind for every worktree
// and — because `-c` travels to child git processes — every submodule a status touched. Whether
// fsmonitor runs is the user's git configuration to decide.

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
 * Returned as a fresh object because Bun's `$.env()` REPLACES the child environment instead of
 * merging into it: without spreading `process.env` git would lose `PATH`/`HOME` and fail in ways
 * that no unit test observes.
 */
export function readOnlyGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
