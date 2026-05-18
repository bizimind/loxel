import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { $ } from "bun";

import { getBranches, getRefs, getStashes } from "./refs";
import type { TempRepo } from "./test-utils";
import { branch, checkoutBranch, commit, createRepo, tag, writeFile } from "./test-utils";

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
