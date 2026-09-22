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
 * The `origin` default branch as a remote-tracking ref (`origin/main`), or
 * null when the repository has none: no `origin` remote, or one that was never
 * fetched with a refspec (a plain `git clone --bare` records no `origin/*`).
 *
 * Purely local: reads `origin/HEAD` when the clone recorded it, otherwise
 * falls back to the conventional names. Never touches the network. `origin/HEAD`
 * is only trusted when its target still exists: it is a symref that git does
 * not retarget when the remote deletes or renames that branch.
 */
export async function resolveRemoteDefault(cwd: string): Promise<string | null> {
  const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const recorded = head.exitCode === 0 ? head.stdout.trim() : "";
  if (recorded && (await remoteRefExists(cwd, recorded))) return recorded;

  for (const candidate of ["origin/main", "origin/master"]) {
    if (await remoteRefExists(cwd, candidate)) return candidate;
  }
  return null;
}

function remoteRefExists(cwd: string, ref: string): Promise<boolean> {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`], cwd);
}
