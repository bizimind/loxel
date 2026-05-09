import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TempRepo } from "./test-utils";

import { getBranchCommits, getLog } from "./log";
import { branch, checkoutBranch, commit, createRepo, merge, tag } from "./test-utils";

/**
 * Template topology (built once, copied per test):
 *
 *   F  Merge feat into main  (main)
 *   |\
 *   | E  feat-E              (feat)
 *   | D  feat-D
 *   |/
 *   C  commit-C
 *   B  commit-B
 *   A  commit-A              (tag: v1)
 */
let template: TempRepo;
let hashes: Record<string, string>;

beforeAll(async () => {
  template = await createRepo();
  const p = template.path;
  hashes = {} as Record<string, string>;

  hashes.A = await commit(p, "commit-A", { "a.txt": "a" });
  await tag(p, "v1");
  hashes.B = await commit(p, "commit-B", { "b.txt": "b" });
  hashes.C = await commit(p, "commit-C", { "c.txt": "c" });

  await branch(p, "feat");
  hashes.D = await commit(p, "feat-D", { "d.txt": "d" });
  hashes.E = await commit(p, "feat-E", { "e.txt": "e" });

  await checkoutBranch(p, "main");
  hashes.F = await merge(p, "feat", "Merge feat into main");
});

afterAll(() => template.cleanup());

describe("getLog", () => {
  test("returns commits in topo order", async () => {
    const repo = await template.copy();
    try {
      const result = await getLog(repo.path);
      const messages = result.map((c) => c.message);
      expect(messages[0]).toBe("Merge feat into main");
      expect(result[0]!.parents).toHaveLength(2);
    } finally {
      await repo.cleanup();
    }
  });

  test("limit truncates result", async () => {
    const repo = await template.copy();
    try {
      const result = await getLog(repo.path, { limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0]!.message).toBe("Merge feat into main");
    } finally {
      await repo.cleanup();
    }
  });

  test("all: true includes all branches", async () => {
    const repo = await template.copy();
    try {
      const result = await getLog(repo.path, { all: true });
      const resultHashes = result.map((c) => c.hash);
      expect(resultHashes).toContain(hashes.D!);
      expect(resultHashes).toContain(hashes.E!);
    } finally {
      await repo.cleanup();
    }
  });

  test("branches filter limits to reachable commits", async () => {
    const repo = await template.copy();
    try {
      const result = await getLog(repo.path, { branches: ["feat"] });
      const messages = result.map((c) => c.message);
      expect(messages).toContain("feat-E");
      expect(messages).toContain("feat-D");
      expect(messages).not.toContain("Merge feat into main");
    } finally {
      await repo.cleanup();
    }
  });

  test("parses parent hashes correctly for merge commit", async () => {
    const repo = await template.copy();
    try {
      const result = await getLog(repo.path, { limit: 1 });
      const mergeCommit = result[0]!;
      expect(mergeCommit.parents).toHaveLength(2);
      expect(mergeCommit.parents).toContain(hashes.C!);
      expect(mergeCommit.parents).toContain(hashes.E!);
    } finally {
      await repo.cleanup();
    }
  });

  test("parses refs on tagged commit", async () => {
    const repo = await template.copy();
    try {
      const result = await getLog(repo.path, { all: true });
      const commitA = result.find((c) => c.hash === hashes.A);
      expect(commitA).toBeDefined();
      const tagRef = commitA!.refs.find((r) => r.type === "tag");
      expect(tagRef?.name).toBe("v1");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getBranchCommits", () => {
  test("returns only branch-specific commits on unmerged branch", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "base-1", { "a.txt": "a" });
      const baseHash = await commit(repo.path, "base-2", { "b.txt": "b" });
      await branch(repo.path, "unmerged");
      await commit(repo.path, "branch-X", { "x.txt": "x" });
      await commit(repo.path, "branch-Y", { "y.txt": "y" });
      const { commits, mergeBase } = await getBranchCommits(repo.path);
      const messages = commits.map((c) => c.message);
      expect(messages).toContain("branch-X");
      expect(messages).toContain("branch-Y");
      expect(messages).not.toContain("base-1");
      expect(messages).not.toContain("base-2");
      expect(mergeBase).toBe(baseHash);
    } finally {
      await repo.cleanup();
    }
  });

  test("detached HEAD returns single commit", async () => {
    const repo = await createRepo();
    try {
      const hash = await commit(repo.path, "solo", { "x.txt": "x" });
      await Bun.$`git -C ${repo.path} checkout --detach ${hash}`.quiet();
      const { commits } = await getBranchCommits(repo.path);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.hash).toBe(hash);
    } finally {
      await repo.cleanup();
    }
  });

  test("single branch repo returns recent commits", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "first", { "a.txt": "a" });
      await commit(repo.path, "second", { "b.txt": "b" });
      const { commits, mergeBase } = await getBranchCommits(repo.path);
      expect(commits.length).toBeGreaterThanOrEqual(2);
      expect(mergeBase).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});
