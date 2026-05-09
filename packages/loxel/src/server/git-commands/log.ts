import { $ } from "bun";

import type { CommitInfo } from "@/api/git-models";

import { LOG_FORMAT, parseLogOutput } from "../parsers/log";
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

  const result = await $`git -C ${cwd} ${args}`.text();
  return parseLogOutput(result);
}

export async function getBranchCommits(
  cwd: string,
  options: { limit?: number } = {},
): Promise<{ commits: CommitInfo[]; mergeBase: string | null }> {
  const { limit = 100 } = options;

  const branchResult = await $`git -C ${cwd} symbolic-ref --short HEAD`.nothrow().text();
  const currentBranch = branchResult.trim();
  if (!currentBranch) {
    const commits = await getLog(cwd, { limit: 1 });
    return { commits, mergeBase: null };
  }

  const refFormat = "%(refname)";
  const refsResult =
    await $`git -C ${cwd} for-each-ref --format=${refFormat} refs/heads refs/remotes`.text();
  const excludeRefs = new Set([
    `refs/heads/${currentBranch}`,
    `refs/remotes/origin/${currentBranch}`,
  ]);
  const otherRefs = refsResult
    .trim()
    .split("\n")
    .filter((r) => r && !excludeRefs.has(r) && !r.endsWith("/HEAD"));

  if (otherRefs.length === 0) {
    const commits = await getLog(cwd, { limit: Math.min(limit, 20) });
    return { commits, mergeBase: null };
  }

  const args: string[] = [
    "log",
    `--format=${LOG_FORMAT}`,
    `-n`,
    String(limit),
    "--topo-order",
    "HEAD",
    "--not",
    ...otherRefs,
  ];
  const result = await $`git -C ${cwd} ${args}`.nothrow().text();
  const commits = parseLogOutput(result.trim());

  const oldest = commits[commits.length - 1];
  const mergeBase = oldest?.parents[0] ?? null;

  return { commits, mergeBase };
}
