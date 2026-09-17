import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { getBranchCommits, getLog } from "./log";
import type { TempRepo } from "./test-utils";
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

/**
 * The cases the original `HEAD --not <all refs>` implementation got wrong.
 *
 * They share a shape: another ref can reach part of this branch's history.
 * `--not` excludes by reachability, so every such ref silently shortened the
 * answer; a merge base against the default branch is indifferent to them.
 */
describe("getBranchCommits — base is the default branch, not 'unique to this branch'", () => {
  /**
   *   main:     A → B
   *   parent:        └─ P1 → P2        (a branch off main)
   *   child:                  └─ C1    (stacked on parent)
   *
   * All three of P1, P2 and C1 belong to the child branch's pull request.
   */
  async function stacked(): Promise<TempRepo> {
    const repo = await createRepo();
    await commit(repo.path, "A", { "a.txt": "a" });
    await commit(repo.path, "B", { "b.txt": "b" });
    await branch(repo.path, "parent");
    await commit(repo.path, "P1", { "p1.txt": "1" });
    await commit(repo.path, "P2", { "p2.txt": "2" });
    await branch(repo.path, "child");
    await commit(repo.path, "C1", { "c1.txt": "1" });
    return repo;
  }

  test("a stacked branch reports the whole range down to the default branch", async () => {
    const repo = await stacked();
    try {
      const { commits, mergeBase } = await getBranchCommits(repo.path);
      const messages = commits.map((c) => c.message);

      // The parent branch's commits are part of this branch's history.
      expect(messages).toEqual(["C1", "P2", "P1"]);
      expect(messages).not.toContain("B");
      expect(mergeBase).toBe(
        (await Bun.$`git -C ${repo.path} rev-parse main`.quiet().text()).trim(),
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("the parent branch still existing does not shorten the list", async () => {
    const repo = await stacked();
    try {
      // `parent` is a real local ref pointing inside child's history — the
      // exact situation that reduced this to one commit.
      expect((await getBranchCommits(repo.path)).commits).toHaveLength(3);
      await Bun.$`git -C ${repo.path} branch -D parent`.quiet();
      expect((await getBranchCommits(repo.path)).commits).toHaveLength(3);
    } finally {
      await repo.cleanup();
    }
  });

  test("a stale ref on this branch's own history is ignored", async () => {
    const repo = await stacked();
    try {
      // What `gh pr checkout` or a backup branch leaves behind: a ref parked a
      // few commits back on the branch itself.
      await Bun.$`git -C ${repo.path} branch pr123 HEAD~1`.quiet();
      await Bun.$`git -C ${repo.path} branch backup-pre-rebase HEAD~2`.quiet();

      const { commits } = await getBranchCommits(repo.path);
      expect(commits.map((c) => c.message)).toEqual(["C1", "P2", "P1"]);
    } finally {
      await repo.cleanup();
    }
  });

  test("a diverged ref sharing history is ignored", async () => {
    const repo = await stacked();
    try {
      // Not an ancestor of HEAD, but reachability still covered the shared
      // commits, so `--not` dropped them.
      await Bun.$`git -C ${repo.path} branch diverged HEAD~1`.quiet();
      await Bun.$`git -C ${repo.path} checkout diverged`.quiet();
      await commit(repo.path, "elsewhere", { "e.txt": "e" });
      await Bun.$`git -C ${repo.path} checkout child`.quiet();

      expect((await getBranchCommits(repo.path)).commits.map((c) => c.message)).toEqual([
        "C1",
        "P2",
        "P1",
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  test("prefers origin/HEAD over a local branch of the same name", async () => {
    const repo = await stacked();
    try {
      // origin/main is deliberately behind local main: the base must follow the
      // remote default, which is what the forge compares against.
      await Bun.$`git -C ${repo.path} update-ref refs/remotes/origin/main main~1`.quiet();
      await Bun.$`git -C ${repo.path} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.quiet();

      const { commits, mergeBase } = await getBranchCommits(repo.path);
      expect(commits.map((c) => c.message)).toEqual(["C1", "P2", "P1", "B"]);
      expect(mergeBase).toBe(
        (await Bun.$`git -C ${repo.path} rev-parse main~1`.quiet().text()).trim(),
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("a branch with no commits of its own yet reports an empty list", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await commit(repo.path, "B", { "b.txt": "b" });
      await Bun.$`git -C ${repo.path} checkout -q -b fresh`.quiet();

      // The old code returned [] here too; showing main's history under the
      // branch's name would be a regression.
      const { commits, mergeBase } = await getBranchCommits(repo.path);
      expect(commits).toEqual([]);
      expect(mergeBase).toBe(
        (await Bun.$`git -C ${repo.path} rev-parse main`.quiet().text()).trim(),
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("unrelated histories fall back to recent commits", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await Bun.$`git -C ${repo.path} checkout -q --orphan orphan`.quiet();
      await Bun.$`git -C ${repo.path} rm -rfq .`.quiet();
      await commit(repo.path, "O1", { "o.txt": "o" });

      const { commits, mergeBase } = await getBranchCommits(repo.path);
      expect(mergeBase).toBeNull();
      expect(commits.map((c) => c.message)).toEqual(["O1"]);
    } finally {
      await repo.cleanup();
    }
  });

  test("on the default branch itself, falls back to recent commits", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await commit(repo.path, "B", { "b.txt": "b" });

      // merge-base(main, HEAD) is HEAD, so the range is empty; an empty panel
      // would be worse than showing recent history.
      const { commits, mergeBase } = await getBranchCommits(repo.path);
      expect(mergeBase).toBeNull();
      expect(commits.map((c) => c.message)).toContain("B");
    } finally {
      await repo.cleanup();
    }
  });

  test("no recognizable default branch falls back to recent commits", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await Bun.$`git -C ${repo.path} branch -m main odd-default`.quiet();
      await Bun.$`git -C ${repo.path} checkout -b topic`.quiet();
      await commit(repo.path, "T1", { "t.txt": "t" });

      const { commits, mergeBase } = await getBranchCommits(repo.path);
      expect(mergeBase).toBeNull();
      expect(commits.map((c) => c.message)).toContain("T1");
    } finally {
      await repo.cleanup();
    }
  });
});
