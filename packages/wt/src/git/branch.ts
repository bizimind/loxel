import { git, gitSucceeds, runGit } from "./run.ts";

/** Whether a local branch exists. */
export function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
}

/** Delete a local branch. Throws with git's stderr on failure. */
export async function deleteBranch(cwd: string, branch: string, force: boolean): Promise<void> {
  await git(["branch", force ? "-D" : "-d", branch], cwd);
}

/** Rename a local branch without overwriting an existing one. Throws with git's stderr on failure. */
export async function renameBranch(cwd: string, from: string, to: string): Promise<void> {
  await git(["branch", "-m", from, to], cwd);
}

/** The current branch name. Throws when HEAD is detached or unavailable. */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === "HEAD") throw new Error("Cannot determine a branch from detached HEAD.");
  return branch;
}

/**
 * The remote default branch as a remote-tracking ref (`origin/main`), or null
 * when the repository has none: no remote, or a remote that was never fetched
 * with a refspec (a plain `git clone --bare` records no `origin/*` refs).
 *
 * Purely local: reads `origin/HEAD` when the clone recorded it, otherwise
 * falls back to the conventional names. Never touches the network.
 */
export async function resolveRemoteDefault(cwd: string): Promise<string | null> {
  const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();

  for (const candidate of ["origin/main", "origin/master"]) {
    if (await gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`], cwd)) {
      return candidate;
    }
  }
  return null;
}
