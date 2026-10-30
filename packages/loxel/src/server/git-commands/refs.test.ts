import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, realpath, rm, truncate } from "node:fs/promises";
import path from "node:path";

import { $ } from "bun";

import type { BranchInfo } from "@/api/git-models";

import { parseBranchOutput } from "../parsers/refs";
import { readOnlyGitEnv } from "./git-env";
import { getBranches, getRecentBranchNames, getRefs, getStashes } from "./refs";
import type { TempRepo } from "./test-utils";
import {
  branch,
  checkoutBranch,
  commit,
  createBareRepo,
  createRepo,
  tag,
  writeFile,
} from "./test-utils";

let template: TempRepo;

beforeAll(async () => {
  template = await createRepo();
  await commit(template.path, "init", { "a.txt": "a" });
  await tag(template.path, "v1.0");
  await branch(template.path, "feature");
  await commit(template.path, "feat work", { "b.txt": "b" });
  await checkoutBranch(template.path, "main");
});

afterAll(() => template.cleanup());

describe("getRefs", () => {
  test("includes local branch refs", async () => {
    const repo = await template.copy();
    try {
      const refs = await getRefs(repo.path);
      const branchRefs = refs.filter((r) => r.type === "head");
      const names = branchRefs.map((r) => r.name);
      expect(names).toContain("main");
      expect(names).toContain("feature");
    } finally {
      await repo.cleanup();
    }
  });

  test("includes tag refs", async () => {
    const repo = await template.copy();
    try {
      const refs = await getRefs(repo.path);
      const tagRefs = refs.filter((r) => r.type === "tag");
      expect(tagRefs.map((r) => r.name)).toContain("v1.0");
    } finally {
      await repo.cleanup();
    }
  });

  test("includes HEAD ref", async () => {
    const repo = await template.copy();
    try {
      const refs = await getRefs(repo.path);
      const headRef = refs.find((r) => r.type === "HEAD");
      expect(headRef).toBeDefined();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getBranches", () => {
  test("marks current branch", async () => {
    const repo = await template.copy();
    try {
      const branches = await getBranches(repo.path);
      const current = branches.find((b) => b.isHead);
      expect(current).toBeDefined();
      expect(current!.name).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });

  test("lists all local branches", async () => {
    const repo = await template.copy();
    try {
      const branches = await getBranches(repo.path);
      const names = branches.map((b) => b.name);
      expect(names).toContain("main");
      expect(names).toContain("feature");
    } finally {
      await repo.cleanup();
    }
  });
});

const AUTHOR_2020 = "2020-01-01T00:00:00.000Z";
const COMMITTER_2021 = "2021-01-01T00:00:00.000Z";
const AUTHOR_2022 = "2022-01-01T00:00:00.000Z";
const COMMITTER_2023 = "2023-01-01T00:00:00.000Z";
const IDENTITY = ["-c", "user.email=test@loxel.dev", "-c", "user.name=Test"];

async function commitAt(cwd: string, message: string, author: string, committer: string) {
  const env = { ...process.env, GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer };
  await $`git -C ${cwd} ${IDENTITY} commit --allow-empty -m ${message}`.env(env).quiet();
  return (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
}

/** The previous implementation, one `git reflog show` per branch: the oracle for the one-call one. */
async function perBranchReflogTime(cwd: string, branchName: string): Promise<number | null> {
  const result = await $`git -C ${cwd} reflog show ${branchName} --format=%at -n 1`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const timestamp = parseInt(result.trim(), 10);
  return isNaN(timestamp) ? null : timestamp;
}

async function perBranchGetBranches(cwd: string): Promise<BranchInfo[]> {
  const format = "%(objectname) %(refname) %(upstream) %(upstream:track)";
  const result = await $`git -C ${cwd} for-each-ref --format=${format} refs/heads`
    .env(readOnlyGitEnv())
    .text();
  const headResult = await $`git -C ${cwd} symbolic-ref --short HEAD`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const timestamps = new Map<string, string>();
  for (const line of result.trim().split("\n")) {
    const name = line.match(/refs\/heads\/(\S+)/)?.[1];
    if (name === undefined) continue;
    const timestamp = await perBranchReflogTime(cwd, name);
    if (timestamp !== null) timestamps.set(name, new Date(timestamp * 1000).toISOString());
  }
  return parseBranchOutput(result, headResult.trim() || null, timestamps);
}

async function perBranchRecentLocalNames(cwd: string, days: number): Promise<string[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceTimestamp = Math.floor(since.getTime() / 1000);
  // Passed as a value: Bun's shell rejects an unquoted `(` in the template with a parse error.
  const format = "%(refname:short)";
  const list = await $`git -C ${cwd} for-each-ref --format=${format} refs/heads`
    .env(readOnlyGitEnv())
    .nothrow()
    .text();
  const recent: string[] = [];
  for (const name of list.trim().split("\n").filter(Boolean)) {
    const timestamp = await perBranchReflogTime(cwd, name);
    if (timestamp !== null && timestamp >= sinceTimestamp) recent.push(name);
  }
  return recent;
}

/** Every directory a scenario queries must agree with the per-branch implementation. */
async function expectSameAsPerBranch(...cwds: string[]) {
  for (const cwd of cwds) {
    expect(await getBranches(cwd)).toEqual(await perBranchGetBranches(cwd));
    for (const days of [1, 36500]) {
      // No remotes in these scenarios, so the result is the local names alone.
      expect(await getRecentBranchNames(cwd, days)).toEqual(
        await perBranchRecentLocalNames(cwd, days),
      );
    }
  }
}

function lastUpdatedOf(branches: BranchInfo[], name: string): string | undefined {
  return branches.find((b) => b.name === name)?.lastUpdated;
}

describe("branch reflog times", () => {
  let repo: TempRepo;
  let bare: TempRepo | undefined;
  let oldCommit: string;

  beforeEach(async () => {
    repo = await createRepo();
    oldCommit = await commitAt(repo.path, "old", AUTHOR_2020, COMMITTER_2021);
    await commitAt(repo.path, "new", AUTHOR_2022, COMMITTER_2023);
  });

  afterEach(async () => {
    await repo.cleanup();
    await bare?.cleanup();
    bare = undefined;
  });

  test("uses the author date of the commit at the newest entry, not when the branch moved", async () => {
    await $`git -C ${repo.path} branch reset-branch`.quiet();
    await $`git -C ${repo.path} branch -f reset-branch ${oldCommit}`.quiet();

    const branches = await getBranches(repo.path);
    expect(lastUpdatedOf(branches, "reset-branch")).toBe(AUTHOR_2020);
    expect(lastUpdatedOf(branches, "main")).toBe(AUTHOR_2022);
    expect(await getRecentBranchNames(repo.path, 1)).toEqual([]);
    await expectSameAsPerBranch(repo.path);
  });

  test("a commit made now makes the branch recent, and only that branch", async () => {
    await $`git -C ${repo.path} branch stale`.quiet();
    await commit(repo.path, "now");
    expect(await getRecentBranchNames(repo.path, 1)).toEqual(["main"]);
    await expectSameAsPerBranch(repo.path);
  });

  test("checking a branch out does not change its time", async () => {
    await $`git -C ${repo.path} branch other ${oldCommit}`.quiet();
    await checkoutBranch(repo.path, "other");
    expect(lastUpdatedOf(await getBranches(repo.path), "other")).toBe(AUTHOR_2020);
    await expectSameAsPerBranch(repo.path);
  });

  test("branches sharing a tip and nested branch names keep their own entries", async () => {
    await $`git -C ${repo.path} branch feat/one`.quiet();
    await $`git -C ${repo.path} branch feat/deep/two ${oldCommit}`.quiet();
    await $`git -C ${repo.path} branch twin`.quiet();
    const branches = await getBranches(repo.path);
    expect(lastUpdatedOf(branches, "feat/deep/two")).toBe(AUTHOR_2020);
    expect(lastUpdatedOf(branches, "twin")).toBe(AUTHOR_2022);
    await expectSameAsPerBranch(repo.path);
  });

  test("branches without a reflog, or with an empty one, have no time", async () => {
    await $`git -C ${repo.path} -c core.logAllRefUpdates=false branch never-logged`.quiet();
    await $`git -C ${repo.path} branch log-deleted`.quiet();
    await rm(path.join(repo.path, ".git/logs/refs/heads/log-deleted"));
    await $`git -C ${repo.path} branch log-emptied`.quiet();
    await truncate(path.join(repo.path, ".git/logs/refs/heads/log-emptied"));

    const branches = await getBranches(repo.path);
    for (const name of ["never-logged", "log-deleted", "log-emptied"]) {
      expect(branches.map((b) => b.name)).toContain(name);
      expect(lastUpdatedOf(branches, name)).toBeUndefined();
    }
    await expectSameAsPerBranch(repo.path);
  });

  test("a tip moved without a reflog entry keeps the time of the newest entry", async () => {
    await $`git -C ${repo.path} branch moved ${oldCommit}`.quiet();
    // Git appends to a reflog that exists on every update it makes, so only a raw write skips it.
    const tip = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
    await Bun.write(path.join(repo.path, ".git/refs/heads/moved"), `${tip}\n`);
    expect(lastUpdatedOf(await getBranches(repo.path), "moved")).toBe(AUTHOR_2020);
    await expectSameAsPerBranch(repo.path);
  });

  test("a newest entry whose commit is gone falls back to the entry before it", async () => {
    await $`git -C ${repo.path} branch pruned ${oldCommit}`.quiet();
    const missing = "1".repeat(40);
    await appendFile(
      path.join(repo.path, ".git/logs/refs/heads/pruned"),
      `${oldCommit} ${missing} Test <test@loxel.dev> 1893456000 +0000\tgone\n`,
    );
    expect(lastUpdatedOf(await getBranches(repo.path), "pruned")).toBe(AUTHOR_2020);
    await expectSameAsPerBranch(repo.path);
  });

  test("a tag sharing a branch's name keeps the ambiguous short name", async () => {
    await $`git -C ${repo.path} branch dup`.quiet();
    await commit(repo.path, "now");
    await $`git -C ${repo.path} update-ref refs/heads/dup HEAD`.quiet();
    await tag(repo.path, "dup");
    expect(await getRecentBranchNames(repo.path, 1)).toContain("main");
    expect(await getRecentBranchNames(repo.path, 36500)).toContain("heads/dup");
    await expectSameAsPerBranch(repo.path);
  });

  test("remote branches are recent by committer date and follow the local ones", async () => {
    await commit(repo.path, "local now");
    const tip = await commitAt(repo.path, "old author", AUTHOR_2020, new Date().toISOString());
    await $`git -C ${repo.path} update-ref refs/remotes/origin/fresh ${tip}`.quiet();
    await $`git -C ${repo.path} update-ref refs/remotes/origin/stale ${oldCommit}`.quiet();
    await $`git -C ${repo.path} branch author-dated-old ${tip}`.quiet();
    expect(await getRecentBranchNames(repo.path, 1)).toEqual(["origin/fresh"]);
  });

  test("log.date does not disturb the parsing", async () => {
    await $`git -C ${repo.path} config log.date iso`.quiet();
    expect(lastUpdatedOf(await getBranches(repo.path), "main")).toBe(AUTHOR_2022);
    await expectSameAsPerBranch(repo.path);
  });

  test("detached HEAD and a repo with no branches", async () => {
    await $`git -C ${repo.path} checkout --detach`.quiet();
    await expectSameAsPerBranch(repo.path);
    await $`git -C ${repo.path} update-ref -d refs/heads/main`.quiet();
    expect(await getBranches(repo.path)).toEqual([]);
    expect(await getRecentBranchNames(repo.path, 36500)).toEqual([]);
    await expectSameAsPerBranch(repo.path);
  });

  test("an unborn branch", async () => {
    const empty = await createRepo();
    try {
      expect(await getBranches(empty.path)).toEqual([]);
      expect(await getRecentBranchNames(empty.path, 36500)).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });

  test("a linked worktree on its own branch reports the same from either checkout", async () => {
    const worktree = `${repo.path}-wt`;
    await $`git -C ${repo.path} worktree add -b wt-branch ${worktree}`.quiet();
    try {
      await commitAt(worktree, "in worktree", AUTHOR_2020, COMMITTER_2021);
      const fromMain = await getBranches(repo.path);
      const fromWorktree = await getBranches(worktree);
      expect(lastUpdatedOf(fromMain, "wt-branch")).toBe(AUTHOR_2020);
      expect(lastUpdatedOf(fromWorktree, "wt-branch")).toBe(AUTHOR_2020);
      expect(fromWorktree.find((b) => b.isHead)?.name).toBe("wt-branch");
      await expectSameAsPerBranch(repo.path, worktree);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  async function populateBareLayout(root: string) {
    const worktree = `${root}-wt`;
    await $`git -C ${root} worktree add --orphan -b wt-branch ${worktree}`.quiet();
    const first = await commitAt(worktree, "first", AUTHOR_2020, COMMITTER_2021);
    const second = await commitAt(worktree, "second", AUTHOR_2022, COMMITTER_2023);
    // A bare directory creates no reflog for a new branch, but appends to one that exists.
    await $`git -C ${root} branch from-bare ${first}`.quiet();
    await $`git -C ${worktree} branch moved-from-bare ${first}`.quiet();
    await $`git -C ${root} branch -f moved-from-bare ${second}`.quiet();
    return worktree;
  }

  test("a bare repo with a linked worktree", async () => {
    bare = await createBareRepo();
    const worktree = await populateBareLayout(bare.path);
    try {
      const branches = await getBranches(bare.path);
      expect(lastUpdatedOf(branches, "wt-branch")).toBe(AUTHOR_2022);
      expect(lastUpdatedOf(branches, "from-bare")).toBeUndefined();
      expect(lastUpdatedOf(branches, "moved-from-bare")).toBe(AUTHOR_2022);
      await expectSameAsPerBranch(bare.path, worktree);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("a bare layout that sets core.bare in config.worktree, as wt does", async () => {
    bare = await createBareRepo();
    await $`git -C ${bare.path} config extensions.worktreeConfig true`.quiet();
    await $`git -C ${bare.path} config --unset core.bare`.quiet();
    await $`git -C ${bare.path} config --worktree core.bare true`.quiet();
    const worktree = await populateBareLayout(await realpath(bare.path));
    try {
      await expectSameAsPerBranch(bare.path, worktree);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe("getStashes", () => {
  test("returns stash entries", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "a.txt", "stashed change");
      await $`git -C ${repo.path} stash push -m "test stash"`.quiet();
      const stashes = await getStashes(repo.path);
      expect(stashes).toHaveLength(1);
      expect(stashes[0]!.message).toContain("test stash");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty for no stashes", async () => {
    const repo = await template.copy();
    try {
      const stashes = await getStashes(repo.path);
      expect(stashes).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});
