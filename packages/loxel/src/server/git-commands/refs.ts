import { $ } from "bun";

import type { BranchInfo, RefInfo, StashInfo } from "@/api/git-models";

import { parseBranchOutput, parseRefsOutput, parseStashOutput } from "../parsers/refs";
import { readOnlyGitEnv } from "./git-env";

let refsCache: { data: RefInfo[]; expiry: number; cwd: string } | null = null;

export async function getRefs(cwd: string): Promise<RefInfo[]> {
  const now = Date.now();
  if (refsCache && refsCache.cwd === cwd && now < refsCache.expiry) {
    return refsCache.data;
  }

  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const [result, head] = await Promise.all([
    $`git -C ${cwd} for-each-ref --format=${format} refs/heads refs/remotes refs/tags`
      .env(readOnlyGitEnv())
      .text(),
    $`git -C ${cwd} rev-parse HEAD`.env(readOnlyGitEnv()).nothrow().text(),
  ]);
  const refs = parseRefsOutput(result, head.trim());
  refsCache = { data: refs, expiry: now + 2000, cwd };
  return refs;
}

/**
 * Author time (unix seconds) of the commit at each local branch's newest reflog entry, by branch
 * name. Branches without a reflog are absent. This is the commit's date rather than the time of the
 * reflog entry, so a branch reset to an old commit reports that commit's old date.
 *
 * One process for all branches: `--branches` resolves each name the way `git reflog show <branch>`
 * does. The walk reads every entry of every branch's reflog because git has no per-ref limit.
 */
async function readBranchReflogTimes(cwd: string): Promise<Map<string, number>> {
  const format = "%gD %at";
  const output =
    await $`git -C ${cwd} log --walk-reflogs --no-show-signature --branches --format=${format}`
      .env(readOnlyGitEnv())
      .nothrow()
      .text();

  const times = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = line.match(/^(.+)@\{[^}]*\} (\d+)$/);
    if (!match?.[1] || !match[2]) continue;
    // Each branch's entries are newest first, even when branches interleave.
    if (!times.has(match[1])) times.set(match[1], parseInt(match[2], 10));
  }
  return times;
}

export async function getBranches(cwd: string): Promise<BranchInfo[]> {
  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const [result, headResult, reflogTimes] = await Promise.all([
    $`git -C ${cwd} for-each-ref --format=${format} refs/heads`.env(readOnlyGitEnv()).text(),
    $`git -C ${cwd} symbolic-ref --short HEAD`.env(readOnlyGitEnv()).nothrow().text(),
    readBranchReflogTimes(cwd),
  ]);
  const headBranch = headResult.trim() || null;

  const branchTimestamps = new Map<string, string>();
  for (const [branch, timestamp] of reflogTimes) {
    branchTimestamps.set(branch, new Date(timestamp * 1000).toISOString());
  }

  return parseBranchOutput(result, headBranch, branchTimestamps);
}

export async function getRecentBranchNames(cwd: string, days: number): Promise<string[]> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const sinceTimestamp = Math.floor(sinceDate.getTime() / 1000);

  const localFormat = "%(refname) %(refname:short)";
  const remoteFormat = "%(refname:short) %(committerdate:unix)";
  const [localResult, reflogTimes, remoteResult] = await Promise.all([
    $`git -C ${cwd} for-each-ref --format=${localFormat} refs/heads`
      .env(readOnlyGitEnv())
      .nothrow()
      .text(),
    readBranchReflogTimes(cwd),
    $`git -C ${cwd} for-each-ref --format=${remoteFormat} refs/remotes`
      .env(readOnlyGitEnv())
      .nothrow()
      .text(),
  ]);

  const recentBranches: string[] = [];

  for (const line of localResult.trim().split("\n")) {
    const [refname, shortName] = line.split(" ");
    if (!refname || !shortName) continue;
    // The short name is `heads/<branch>` when a tag shares the branch's name; callers get it as is.
    const timestamp = reflogTimes.get(refname.slice("refs/heads/".length));
    if (timestamp !== undefined && timestamp >= sinceTimestamp) recentBranches.push(shortName);
  }

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
  const result = await $`git -C ${cwd} stash list`.env(readOnlyGitEnv()).nothrow().text();
  return parseStashOutput(result);
}
