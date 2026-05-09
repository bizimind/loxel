import { $ } from "bun";
import { describe, expect, test } from "bun:test";

import { commit, createRepo, writeFile } from "./test-utils";
import {
  getDirtyWorktreeStatuses,
  getWorktrees,
  getWorktreeStatus,
  parseWorktreeListOutput,
} from "./worktree";

describe("parseWorktreeListOutput", () => {
  test.each([
    {
      name: "regular repo with branch",
      input: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n",
      expected: [{ path: "/repo", branch: "main", commit: "abc123", isMain: true }],
    },
    {
      name: "detached HEAD",
      input: "worktree /repo\nHEAD abc123\ndetached\n",
      expected: [{ path: "/repo", branch: null, commit: "abc123", isMain: true }],
    },
    { name: "bare repo excluded", input: "worktree /repo\nHEAD abc123\nbare\n", expected: [] },
    {
      name: "multiple worktrees",
      input: [
        "worktree /main\nHEAD aaa\nbranch refs/heads/main\n",
        "worktree /feat\nHEAD bbb\nbranch refs/heads/feat\n",
      ].join("\n"),
      expected: [
        { path: "/main", branch: "main", commit: "aaa", isMain: true },
        { path: "/feat", branch: "feat", commit: "bbb", isMain: false },
      ],
    },
  ])("$name", ({ input, expected }) => {
    const result = parseWorktreeListOutput(input);
    expect(result).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(result[i]).toMatchObject(expected[i]!);
    }
  });
});

describe("getWorktrees", () => {
  test("lists main and added worktree", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      const wtPath = `${repo.path}-wt`;
      await $`git -C ${repo.path} worktree add ${wtPath} -b wt-branch`.quiet();
      try {
        const worktrees = await getWorktrees(repo.path);
        expect(worktrees).toHaveLength(2);
        const branches = worktrees.map((wt) => wt.branch);
        expect(branches).toContain("main");
        expect(branches).toContain("wt-branch");
      } finally {
        await $`git -C ${repo.path} worktree remove ${wtPath}`.quiet();
      }
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getWorktreeStatus", () => {
  test("returns status for worktree", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      const status = await getWorktreeStatus(repo.path);
      expect(status.branch).toBe("main");
      expect(status.staged).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getDirtyWorktreeStatuses", () => {
  test("returns empty for clean worktrees", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      const statuses = await getDirtyWorktreeStatuses(repo.path);
      expect(statuses).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns entry for dirty worktree", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      await writeFile(repo.path, "a.txt", "dirty");
      const statuses = await getDirtyWorktreeStatuses(repo.path);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]!.path).toBe(repo.path);
      expect(statuses[0]!.unstaged.length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });
});
