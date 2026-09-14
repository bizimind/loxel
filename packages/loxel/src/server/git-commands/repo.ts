import path from "node:path";

import { $ } from "bun";

import { readOnlyGitEnv } from "./git-env";

export async function isBareRepo(cwd: string): Promise<boolean> {
  const result = await $`git -C ${cwd} rev-parse --is-bare-repository`.env(readOnlyGitEnv()).text();
  return result.trim() === "true";
}

/**
 * The ref a branch should be compared against: the repository's default branch.
 *
 * Git records no link between a branch and the branch it was created from, so
 * there is nothing to look up — the default branch is the closest thing to the
 * base a pull request would use, and is what makes a local branch view agree
 * with a forge's. Returns a ref usable with `git merge-base`, or null when the
 * repository has no recognizable default.
 *
 * `branch.<name>.merge` is deliberately not consulted: for a topic branch the
 * configured upstream is almost always the identically-named remote branch,
 * which is useless as a base.
 */
export async function resolveDefaultBranchRef(cwd: string): Promise<string | null> {
  const originHead = await $`git -C ${cwd} symbolic-ref --short refs/remotes/origin/HEAD`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  if (originHead.trim()) return originHead.trim();

  // Some clones never get origin/HEAD (it is set at clone time and is easy to
  // lose), so fall back to the conventional names before giving up.
  for (const candidate of ["origin/main", "origin/master"]) {
    if (await refExists(cwd, candidate)) return candidate;
  }

  // A bare repository's own HEAD *is* the default branch. In a worktree it is
  // merely the checked-out branch, so this only applies when bare.
  if (await isBareRepo(cwd)) {
    const head = await $`git -C ${cwd} symbolic-ref --short HEAD`
      .env(readOnlyGitEnv())
      .nothrow()
      .text();
    if (head.trim()) return head.trim();
  }

  for (const candidate of ["main", "master"]) {
    if (await refExists(cwd, candidate)) return candidate;
  }

  return null;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await $`git -C ${cwd} rev-parse --verify --quiet ${`${ref}^{commit}`}`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.trim() !== "";
}

export async function getGitRoot(cwd: string): Promise<string> {
  try {
    const result = await $`git -C ${cwd} rev-parse --show-toplevel`.env(readOnlyGitEnv()).text();
    return result.trim();
  } catch {
    // Bare repos don't have a working tree — use the git-common-dir as the root
    const result = await $`git -C ${cwd} rev-parse --git-common-dir`.env(readOnlyGitEnv()).text();
    const trimmed = result.trim();
    return trimmed.startsWith("/") ? trimmed : path.resolve(cwd, trimmed);
  }
}
