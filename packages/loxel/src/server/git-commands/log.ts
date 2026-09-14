import { $ } from "bun";

import type { CommitInfo } from "@/api/git-models";

import { LOG_FORMAT, parseLogOutput } from "../parsers/log";
import { readOnlyGitEnv } from "./git-env";
import { resolveDefaultBranchRef } from "./repo";
import { validateRefName } from "./validation";

export async function getLog(
  cwd: string,
  options: { limit?: number; all?: boolean; branches?: string[]; since?: string } = {},
) {
  const { limit = 100, all = false, branches = [], since } = options;

  for (const branch of branches) {
    validateRefName(branch);
  }

  const args: string[] = ["log", `--format=${LOG_FORMAT}`, `-n`, String(limit)];

  if (since) {
    if (!/^[\d.a-zA-Z-]+$/.test(since)) {
      throw new Error(`Invalid since format: ${since}`);
    }
    args.push(`--since=${since}`);
  }

  args.push("--topo-order");

  if (all) {
    args.push("--all");
  } else if (branches.length > 0) {
    args.push(...branches);
  }

  const result = await $`git -C ${cwd} ${args}`.env(readOnlyGitEnv()).text();
  return parseLogOutput(result);
}

/**
 * The commits this branch adds on top of the repository's default branch —
 * `merge-base(default, HEAD)..HEAD`, the same range a pull request shows.
 *
 * This deliberately does *not* ask for commits unique to this branch relative
 * to every other ref (`HEAD --not <all refs>`), which is what it used to do.
 * That excluded by reachability, so any ref sharing history truncated the
 * list: a branch stacked on another showed only the commits added since the
 * parent branch, and a stale ref left behind by `gh pr checkout` or a
 * `backup-` branch silently clipped it further. Measured on a real stacked
 * branch, that reported 2 commits where the pull request had 17.
 *
 * `mergeBase` is null when there is nothing to compare against — a detached
 * HEAD, a repository with no recognizable default branch, or HEAD being the
 * default branch itself — and the commits are then the most recent ones, since
 * an empty panel is worse than a rough answer.
 */
export async function getBranchCommits(
  cwd: string,
  options: { limit?: number } = {},
): Promise<{ commits: CommitInfo[]; mergeBase: string | null }> {
  const { limit = 100 } = options;

  const branchResult = await $`git -C ${cwd} symbolic-ref --short HEAD`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const currentBranch = branchResult.trim();
  if (!currentBranch) {
    const commits = await getLog(cwd, { limit: 1 });
    return { commits, mergeBase: null };
  }

  const defaultRef = await resolveDefaultBranchRef(cwd);
  if (!defaultRef || defaultRef === currentBranch || defaultRef.endsWith(`/${currentBranch}`)) {
    return { commits: await recentCommits(cwd, limit), mergeBase: null };
  }

  const mergeBaseResult = await $`git -C ${cwd} merge-base ${defaultRef} HEAD`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const mergeBase = mergeBaseResult.trim();
  if (!mergeBase) {
    // Unrelated histories, or the default ref is gone since we resolved it.
    return { commits: await recentCommits(cwd, limit), mergeBase: null };
  }

  const args = [
    "log",
    `--format=${LOG_FORMAT}`,
    "-n",
    String(limit),
    "--topo-order",
    `${mergeBase}..HEAD`,
  ];
  const result = await $`git -C ${cwd} ${args}`.env(readOnlyGitEnv()).nothrow().text();
  const commits = parseLogOutput(result.trim());

  // HEAD sitting on the default branch has no commits of its own to show.
  if (commits.length === 0) {
    return { commits: await recentCommits(cwd, limit), mergeBase: null };
  }

  return { commits, mergeBase };
}

function recentCommits(cwd: string, limit: number): Promise<CommitInfo[]> {
  return getLog(cwd, { limit: Math.min(limit, 20) });
}
