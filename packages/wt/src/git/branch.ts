import { git, gitSucceeds } from "./run.ts";

/** Whether a local branch exists. */
export function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
}

/** Delete a local branch. Throws with git's stderr on failure. */
export async function deleteBranch(cwd: string, branch: string, force: boolean): Promise<void> {
  await git(["branch", force ? "-D" : "-d", branch], cwd);
}

/** Rename a local branch. Throws with git's stderr on failure. */
export async function renameBranch(
  cwd: string,
  from: string,
  to: string,
  force: boolean,
): Promise<void> {
  await git(["branch", force ? "-M" : "-m", from, to], cwd);
}

/** The current branch name. Throws when HEAD is detached or unavailable. */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === "HEAD") throw new Error("Cannot determine a branch from detached HEAD.");
  return branch;
}
