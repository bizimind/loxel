import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { $ } from "bun";

import { getStatus } from "./status";
import type { TempRepo } from "./test-utils";
import { branch, checkoutBranch, commit, createRepo, stageFile, writeFile } from "./test-utils";

let template: TempRepo;

beforeAll(async () => {
  template = await createRepo();
  await commit(template.path, "init", { "existing.txt": "original\n" });
});

afterAll(() => template.cleanup());

describe("getStatus", () => {
  test.each([
    {
      name: "clean repo",
      mutate: async (_p: string) => {},
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    },
    {
      name: "staged new file",
      mutate: async (p: string) => {
        await writeFile(p, "new.txt", "content");
        await stageFile(p, "new.txt");
      },
      counts: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    },
    {
      name: "unstaged modification",
      mutate: async (p: string) => {
        await writeFile(p, "existing.txt", "changed\n");
      },
      counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    },
    {
      name: "untracked file",
      mutate: async (p: string) => {
        await writeFile(p, "brand-new.txt", "x");
      },
      counts: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
    },
    {
      name: "staged + unstaged on same file",
      mutate: async (p: string) => {
        await writeFile(p, "existing.txt", "staged-change\n");
        await stageFile(p, "existing.txt");
        await writeFile(p, "existing.txt", "further-change\n");
      },
      counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
    },
  ])("$name", async ({ mutate, counts }) => {
    const repo = await template.copy();
    try {
      await mutate(repo.path);
      const status = await getStatus(repo.path);
      expect(status.staged).toHaveLength(counts.staged);
      expect(status.unstaged).toHaveLength(counts.unstaged);
      expect(status.untracked).toHaveLength(counts.untracked);
      expect(status.conflicted).toHaveLength(counts.conflicted);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports correct branch name", async () => {
    const repo = await template.copy();
    try {
      const status = await getStatus(repo.path);
      expect(status.branch).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });

  test("reports correct commit hash", async () => {
    const repo = await template.copy();
    try {
      const head = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
      const status = await getStatus(repo.path);
      expect(status.commit).toBe(head);
    } finally {
      await repo.cleanup();
    }
  });

  test("detects merge conflict", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "base", { "conflict.txt": "base\n" });
      await branch(repo.path, "other");
      await commit(repo.path, "other-change", { "conflict.txt": "other\n" });
      await checkoutBranch(repo.path, "main");
      await commit(repo.path, "main-change", { "conflict.txt": "main\n" });
      await $`git -C ${repo.path} merge other --no-commit`.nothrow().quiet();
      const status = await getStatus(repo.path);
      expect(status.conflicted.length).toBeGreaterThan(0);
      expect(status.conflicted[0]!.path).toBe("conflict.txt");
    } finally {
      await repo.cleanup();
    }
  });
});
