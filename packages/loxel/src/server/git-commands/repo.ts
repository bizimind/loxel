import path from "node:path";

import { $ } from "bun";

import { resolveCommit } from "./diff";
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
  // A remote's HEAD is the forge's own answer. `origin` wins when several
  // remotes have one; a fork-plus-upstream layout usually keeps them in sync.
  const remoteHead = await resolveRemoteHead(cwd);
  if (remoteHead) return remoteHead;

  // Some clones never get origin/HEAD (it is set at clone time and is easy to
  // lose), so fall back to the conventional names before giving up.
  for (const candidate of ["origin/main", "origin/master"]) {
    if (await refExists(cwd, candidate)) return candidate;
  }

  // A bare repository's own HEAD *is* the default branch, and it is shared by
  // every linked worktree through the common git dir. A worktree's own HEAD
  // is merely the checked-out branch, so this only applies when the
  // repository itself is bare (core.bare is inherited by linked worktrees,
  // where --is-bare-repository would say false).
  if (await isBareRepositoryConfig(cwd)) {
    const commonDir = await $`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`
      .env(readOnlyGitEnv())
      .nothrow()
      .text();
    const head = await $`git -C ${commonDir.trim()} symbolic-ref --short HEAD`
      .env(readOnlyGitEnv())
      .nothrow()
      .text();
    // HEAD is set once at creation and never rewritten, so it dangles after
    // `init --bare` followed by a push of `main`, or a `master` -> `main`
    // rename upstream. Only a branch that exists can be a base.
    const bareHead = head.trim();
    if (bareHead && (await refExists(cwd, bareHead))) return bareHead;
  }

  // A repository created locally with a custom init.defaultBranch has no
  // remote to learn the name from, but the config still records it.
  const configured = await $`git -C ${cwd} config --get init.defaultBranch`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const candidates = [configured.trim(), "main", "master"].filter((name) => name.length > 0);
  for (const candidate of candidates) {
    if (await refExists(cwd, candidate)) return candidate;
  }

  return null;
}

/** The short ref a remote HEAD points at (`origin/main`), preferring `origin`. */
async function resolveRemoteHead(cwd: string): Promise<string | null> {
  const format = "%(refname) %(symref)";
  const output = await $`git -C ${cwd} for-each-ref --format=${format} refs/remotes`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const heads = output
    .trim()
    .split("\n")
    .map((line) => line.split(" "))
    .filter(
      (parts): parts is [string, string] =>
        parts.length === 2 &&
        /^refs\/remotes\/[^/]+\/HEAD$/.test(parts[0]!) &&
        parts[1]!.startsWith("refs/remotes/"),
    );
  const chosen = heads.find(([ref]) => ref === "refs/remotes/origin/HEAD") ?? heads[0];
  return chosen ? chosen[1].slice("refs/remotes/".length) : null;
}

async function isBareRepositoryConfig(cwd: string): Promise<boolean> {
  const result = await $`git -C ${cwd} config --get core.bare`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  return result.trim() === "true";
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await resolveCommit(cwd, ref)) !== null;
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
