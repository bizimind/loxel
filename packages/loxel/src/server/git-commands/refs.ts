import { $ } from "bun";

import type { BranchInfo, RefInfo, StashInfo } from "@/api/git-models";

import { parseBranchOutput, parseRefsOutput, parseStashOutput } from "../parsers/refs";

let refsCache: { data: RefInfo[]; expiry: number; cwd: string } | null = null;

export async function getRefs(cwd: string): Promise<RefInfo[]> {
  const now = Date.now();
  if (refsCache && refsCache.cwd === cwd && now < refsCache.expiry) {
    return refsCache.data;
  }

  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const [result, head] = await Promise.all([
    $`git -C ${cwd} for-each-ref --format=${format} refs/heads refs/remotes refs/tags`.text(),
    $`git -C ${cwd} rev-parse HEAD`.nothrow().text(),
  ]);
  const refs = parseRefsOutput(result, head.trim());
  refsCache = { data: refs, expiry: now + 2000, cwd };
  return refs;
}

export async function getBranches(cwd: string): Promise<BranchInfo[]> {
  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const [result, headResult] = await Promise.all([
    $`git -C ${cwd} for-each-ref --format=${format} refs/heads`.text(),
    $`git -C ${cwd} symbolic-ref --short HEAD`.nothrow().text(),
  ]);
  const headBranch = headResult.trim() || null;

  const localBranches = result
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.match(/refs\/heads\/(\S+)/)?.[1])
    .filter((b): b is string => b !== undefined);

  const branchTimestamps = new Map<string, string>();
  const reflogFormat = "%at";
  const reflogResults = await Promise.all(
    localBranches.map(async (branch) => {
      const reflogResult =
        await $`git -C ${cwd} reflog show ${branch} --format=${reflogFormat} -n 1`.nothrow().text();
      const timestamp = parseInt(reflogResult.trim(), 10);
      return { branch, timestamp: isNaN(timestamp) ? null : timestamp };
    }),
  );
  for (const { branch, timestamp } of reflogResults) {
    if (timestamp !== null) {
      branchTimestamps.set(branch, new Date(timestamp * 1000).toISOString());
    }
  }

  return parseBranchOutput(result, headBranch, branchTimestamps);
}

export async function getRecentBranchNames(cwd: string, days: number): Promise<string[]> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const sinceTimestamp = Math.floor(sinceDate.getTime() / 1000);

  const branchListResult = await $`git -C ${cwd} for-each-ref --format=%(refname:short) refs/heads`
    .nothrow()
    .text();
  const localBranches = branchListResult
    .trim()
    .split("\n")
    .filter((b) => b);

  const remoteFormat = "%(refname:short) %(committerdate:unix)";
  const [localResults, remoteResult] = await Promise.all([
    Promise.all(
      localBranches.map(async (branch) => {
        const reflogResult = await $`git -C ${cwd} reflog show ${branch} --format=%at -n 1`
          .nothrow()
          .text();
        const timestamp = parseInt(reflogResult.trim(), 10);
        if (!isNaN(timestamp) && timestamp >= sinceTimestamp) return branch;
        return null;
      }),
    ),
    $`git -C ${cwd} for-each-ref --format=${remoteFormat} refs/remotes`.nothrow().text(),
  ]);

  const recentBranches = localResults.filter((b): b is string => b !== null);

  for (const line of remoteResult.trim().split("\n")) {
    if (!line) continue;
    const match = line.match(/^(.+)\s+(\d+)$/);
    if (match && match[1] && match[2]) {
      if (match[1].endsWith("/HEAD")) continue;
      const commitTime = parseInt(match[2], 10);
      if (commitTime >= sinceTimestamp) {
        recentBranches.push(match[1]);
      }
    }
  }

  return recentBranches;
}

export async function getStashes(cwd: string): Promise<StashInfo[]> {
  const result = await $`git -C ${cwd} stash list`.nothrow().text();
  return parseStashOutput(result);
}
