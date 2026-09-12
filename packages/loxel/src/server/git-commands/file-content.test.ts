import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { $ } from "bun";

import { getFileContent } from "./file-content";
import type { TempRepo } from "./test-utils";
import { commit, createRepo } from "./test-utils";

let template: TempRepo;

beforeAll(async () => {
  template = await createRepo();
  await commit(template.path, "init", { "hello.txt": "hello\n" });
});

afterAll(() => template.cleanup());

describe("getFileContent", () => {
  /** A linked worktree holding a file that the project's HEAD does not have. */
  async function repoWithWorktree(): Promise<{ repo: TempRepo; wtPath: string }> {
    const repo = await template.copy();
    const wtPath = path.join(repo.path, ".worktrees", "feature");
    await $`git -C ${repo.path} worktree add -b feature ${wtPath}`.quiet();
    await commit(wtPath, "add branch-only file", { "only-on-branch.txt": "branch\n" });
    return { repo, wtPath };
  }

  test("resolves a symbolic ref in the given worktree", async () => {
    const { repo, wtPath } = await repoWithWorktree();
    try {
      const lines = await getFileContent(repo.path, "only-on-branch.txt", "HEAD", wtPath);
      expect(lines[0]).toBe("branch");
    } finally {
      await repo.cleanup();
    }
  });

  test("without a worktree, the same ref resolves in the project and finds nothing", async () => {
    const { repo, wtPath } = await repoWithWorktree();
    try {
      // The regression: the file exists at the worktree's HEAD but not the
      // project's, so reading it against the project silently yields nothing.
      expect(await getFileContent(repo.path, "only-on-branch.txt", "HEAD")).toEqual([]);
      expect(await getFileContent(repo.path, "only-on-branch.txt", "HEAD", wtPath)).not.toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test("a missing path yields no lines rather than one empty line", async () => {
    const repo = await template.copy();
    try {
      // `[""]` would render as a one-line empty file, indistinguishable from
      // a real empty file and from a successful read.
      expect(await getFileContent(repo.path, "nope.txt", "HEAD")).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test("reads a file that does exist at the ref", async () => {
    const repo = await template.copy();
    try {
      expect((await getFileContent(repo.path, "hello.txt", "HEAD"))[0]).toBe("hello");
    } finally {
      await repo.cleanup();
    }
  });

  test("rejects a worktree path outside the repository", async () => {
    const repo = await template.copy();
    try {
      await expect(
        getFileContent(repo.path, "hello.txt", "HEAD", "/tmp/not-a-worktree"),
      ).rejects.toThrow(/Invalid worktree path/);
    } finally {
      await repo.cleanup();
    }
  });
});
