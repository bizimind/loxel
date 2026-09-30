import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { $ } from "bun";

import type { StatusInfo } from "@/api/git-models";

import { commit, createRepo, writeFile } from "./test-utils";
import { getWorktrees, parseWorktreeListOutput, readWorktreeStatuses } from "./worktree";

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

describe("readWorktreeStatuses", () => {
  test("reports a clean worktree as null", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      const probes = await readWorktreeStatuses(repo.path);
      expect(probes).toHaveLength(1);
      expect(probes[0]!.worktree.path).toBe(repo.path);
      expect(probes[0]!.status).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });

  test("reports a dirty worktree with its changes and current branch", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      await writeFile(repo.path, "a.txt", "dirty");
      const probes = await readWorktreeStatuses(repo.path);
      expect(probes[0]!.status).toMatchObject({ path: repo.path, branch: "main", isMain: true });
      expect(probes[0]!.status!.unstaged.length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("uses a live status instead of running git for that worktree", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      const live: StatusInfo = {
        branch: "main",
        commit: "abc",
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: ["only-in-the-snapshot.txt"],
        conflicted: [],
      };
      const probes = await readWorktreeStatuses(repo.path, {
        liveStatus: (wtPath) => (wtPath === repo.path ? live : undefined),
      });
      expect(probes[0]!.status?.untracked).toEqual(["only-in-the-snapshot.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports a deleted but unpruned worktree as clean", async () => {
    const repo = await createRepo();
    const wtPath = `${repo.path}-gone`;
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      await $`git -C ${repo.path} worktree add -q ${wtPath} -b gone`.quiet();
      await writeFile(wtPath, "dirty.txt", "x");
      // Deleted behind git's back and not pruned: still listed, nothing left to show.
      await rm(wtPath, { recursive: true, force: true });
      const probes = await readWorktreeStatuses(repo.path);
      expect(probes.map((probe) => [probe.worktree.path, probe.status])).toEqual([
        [repo.path, null],
        [wtPath, null],
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports an existing but unreadable worktree as undefined rather than clean", async () => {
    const repo = await createRepo();
    const wtPath = `${repo.path}-broken`;
    try {
      await commit(repo.path, "init", { "a.txt": "a" });
      await $`git -C ${repo.path} worktree add -q ${wtPath} -b broken`.quiet();
      // The directory is still there but is no longer a checkout git can read.
      await rm(`${wtPath}/.git`, { force: true });
      const probes = await readWorktreeStatuses(repo.path);
      expect(probes.map((probe) => [probe.worktree.path, probe.status])).toEqual([
        [repo.path, null],
        [wtPath, undefined],
      ]);
    } finally {
      await rm(wtPath, { recursive: true, force: true });
      await repo.cleanup();
    }
  });
});
