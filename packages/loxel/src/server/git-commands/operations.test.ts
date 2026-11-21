import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { $ } from "bun";

import { checkout, createBranch, deleteBranch, renameBranch } from "./operations";
import type { TempRepo } from "./test-utils";
import { commit, createRepo, writeFile } from "./test-utils";

let template: TempRepo;

beforeAll(async () => {
  template = await createRepo();
  await commit(template.path, "init", { "a.txt": "a\n" });
  await $`git -C ${template.path} branch other`.quiet();
});

afterAll(() => template.cleanup());

async function currentBranch(repo: string): Promise<string> {
  return (await $`git -C ${repo} branch --show-current`.text()).trim();
}

async function status(repo: string): Promise<string> {
  return (await $`git -C ${repo} status --porcelain`.text()).trim();
}

describe("checkout", () => {
  test("switches to the branch and keeps uncommitted changes", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "a.txt", "edited\n");
      await checkout(repo.path, "other");
      expect(await currentBranch(repo.path)).toBe("other");
      expect(await status(repo.path)).toBe("M a.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("rejects a ref that starts with a dash and leaves the worktree untouched", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "a.txt", "edited\n");
      await expect(checkout(repo.path, "-f")).rejects.toThrow("Invalid ref name");
      expect(await currentBranch(repo.path)).toBe("main");
      expect(await status(repo.path)).toBe("M a.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("branch operations", () => {
  test("create, rename and delete a branch", async () => {
    const repo = await template.copy();
    try {
      await createBranch(repo.path, "topic", "main");
      await renameBranch(repo.path, "topic", "renamed");
      await deleteBranch(repo.path, "renamed");
      const branches = (await $`git -C ${repo.path} branch ${"--format=%(refname:short)"}`.text())
        .split("\n")
        .filter(Boolean);
      expect(branches.toSorted()).toEqual(["main", "other"]);
    } finally {
      await repo.cleanup();
    }
  });

  test("rejects branch names that start with a dash", async () => {
    const repo = await template.copy();
    try {
      await expect(createBranch(repo.path, "-D")).rejects.toThrow("Invalid ref name");
      await expect(deleteBranch(repo.path, "--all")).rejects.toThrow("Invalid ref name");
      await expect(renameBranch(repo.path, "other", "-f")).rejects.toThrow("Invalid ref name");
    } finally {
      await repo.cleanup();
    }
  });
});
