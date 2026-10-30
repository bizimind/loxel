import type { BranchInfo, RefInfo, StashInfo } from "@/api/git-models";

import { logger } from "../logger";
import { parseBranchOutput, parseRefsOutput, parseStashOutput } from "../parsers/refs";
import { mapWithConcurrency } from "./concurrency";
import { readOnlyGitEnv } from "./git-env";
import { gitText, runGit } from "./run-git";

const log = logger.child("git");

const REFLOG_FALLBACK_CONCURRENCY = 6;

let refsCache: { data: RefInfo[]; expiry: number; cwd: string } | null = null;

export async function getRefs(cwd: string): Promise<RefInfo[]> {
  const now = Date.now();
  if (refsCache && refsCache.cwd === cwd && now < refsCache.expiry) {
    return refsCache.data;
  }

  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const [result, head] = await Promise.all([
    gitText(["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes", "refs/tags"], {
      cwd,
      env: readOnlyGitEnv(),
    }),
    gitText(["rev-parse", "HEAD"], { cwd, env: readOnlyGitEnv(), nothrow: true }),
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
 * One process for all branches. `--branches` hands git each bare branch name, resolved the way
 * `git reflog show <branch>` resolves it. The walk reads every entry of every branch's reflog
 * because git has no per-ref limit.
 */
async function readBranchReflogTimes(cwd: string): Promise<Map<string, number>> {
  const format = "%gD %at";
  const result = await runGit(
    [
      "log",
      "--walk-reflogs",
      "--no-show-signature",
      "--encoding=UTF-8",
      "--branches",
      `--format=${format}`,
    ],
    { cwd, env: readOnlyGitEnv(), nothrow: true },
  );
  if (result.exitCode !== 0) {
    log.warn("reflog walk failed, reading branches one by one", {
      cwd,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return readBranchReflogTimesOneByOne(cwd);
  }

  const times = new Map<string, number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^(.+)@\{\d+\} (\d+)$/);
    if (!match?.[1] || !match[2]) continue;
    // Each branch's entries are newest first, even when branches interleave.
    if (!times.has(match[1])) times.set(match[1], parseInt(match[2], 10));
  }
  return times;
}

/**
 * A missing or corrupt object anywhere in the reflogs kills the whole walk. One process per branch
 * confines that damage to the branches it actually affects, at the cost of the spawns.
 */
async function readBranchReflogTimesOneByOne(cwd: string): Promise<Map<string, number>> {
  const listFormat = "%(refname:lstrip=2)";
  const list = await gitText(["for-each-ref", `--format=${listFormat}`, "refs/heads"], {
    cwd,
    env: readOnlyGitEnv(),
    nothrow: true,
  });
  const branches = list.trim().split("\n").filter(Boolean);

  const times = new Map<string, number>();
  await mapWithConcurrency(branches, REFLOG_FALLBACK_CONCURRENCY, async (branch) => {
    const output = await gitText(["reflog", "show", branch, "--format=%at", "-n", "1"], {
      cwd,
      env: readOnlyGitEnv(),
      nothrow: true,
    });
    const timestamp = parseInt(output.trim(), 10);
    if (!isNaN(timestamp)) times.set(branch, timestamp);
  });
  return times;
}

export async function getBranches(cwd: string): Promise<BranchInfo[]> {
  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const [result, headResult, reflogTimes] = await Promise.all([
    gitText(["for-each-ref", `--format=${format}`, "refs/heads"], { cwd, env: readOnlyGitEnv() }),
    gitText(["symbolic-ref", "--short", "HEAD"], { cwd, env: readOnlyGitEnv(), nothrow: true }),
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
    gitText(["for-each-ref", `--format=${localFormat}`, "refs/heads"], {
      cwd,
      env: readOnlyGitEnv(),
      nothrow: true,
    }),
    readBranchReflogTimes(cwd),
    gitText(["for-each-ref", `--format=${remoteFormat}`, "refs/remotes"], {
      cwd,
      env: readOnlyGitEnv(),
      nothrow: true,
    }),
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
  const result = await gitText(["stash", "list"], { cwd, env: readOnlyGitEnv(), nothrow: true });
  return parseStashOutput(result);
}
