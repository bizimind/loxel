import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createTestDirectory, createTestRepo, type TestRepo } from "../test-repo.ts";
import { detectRepoType, transformToBare } from "./repo.ts";
import { git } from "./run.ts";

let repo: TestRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

describe("detectRepoType", () => {
  test("does not mistake a regular repo under a 'worktrees' directory for a linked worktree", async () => {
    const directory = await createTestDirectory();
    try {
      const nested = join(directory.root, "worktrees", "plain");
      await git(["init", "--initial-branch=main", nested], directory.root);
      expect(await detectRepoType(nested)).toBe("regular");
      expect(await detectRepoType(join(nested, ".git"))).toBe("regular");
    } finally {
      await directory.cleanup();
    }
  });

  test("classifies a linked worktree by its separate git dir", async () => {
    repo = await createTestRepo();
    const linked = join(repo.root, ".worktrees", "side");
    await git(["worktree", "add", "-b", "side", linked], repo.root);
    expect(await detectRepoType(linked)).toBe("worktree");
  });
});

describe("transformToBare", () => {
  test("registers a branch containing slashes as a valid linked worktree", async () => {
    repo = await createTestRepo();
    await git(["checkout", "-b", "feat/topic"], repo.root);

    const worktreePath = await transformToBare(repo.root, "feat/topic");

    expect(worktreePath).toBe(join(repo.root, ".worktrees", "feat", "topic"));
    expect(await detectRepoType(repo.root)).toBe("bare");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)).toBe("feat/topic");
    expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(true);
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).toContain(
      `worktree ${worktreePath}`,
    );
    // The hand-written admin entry has no index; without one every tracked file
    // would read as staged-deleted plus untracked.
    expect(await git(["status", "--porcelain"], worktreePath)).toBe("");
  });

  test("refuses conversion when linked worktrees already exist", async () => {
    repo = await createTestRepo();
    const linkedPath = join(repo.root, "..", "linked");
    await git(["worktree", "add", "-b", "linked", linkedPath], repo.root);

    await expect(transformToBare(repo.root, "main")).rejects.toThrow(
      "already has linked worktrees",
    );

    expect(await detectRepoType(repo.root)).toBe("regular");
    expect(await Bun.file(join(repo.root, "README.md")).exists()).toBe(true);
    expect(await Bun.file(join(linkedPath, "README.md")).exists()).toBe(true);
  });

  test("refuses conversion when the destination already contains ignored files", async () => {
    repo = await createTestRepo();
    const destination = join(repo.root, ".worktrees", "main");
    await Bun.write(join(destination, "local-secret"), "keep me");
    await Bun.write(join(repo.root, ".gitignore"), ".worktrees/\n");
    await git(["add", ".gitignore"], repo.root);
    await git(["commit", "-m", "ignore local worktrees"], repo.root);

    await expect(transformToBare(repo.root, "main")).rejects.toThrow("destination already exists");

    expect(await detectRepoType(repo.root)).toBe("regular");
    expect(await Bun.file(join(repo.root, "README.md")).exists()).toBe(true);
    expect(await Bun.file(join(destination, "local-secret")).text()).toBe("keep me");
  });

  test("honors WT_DIR for the converted working tree", async () => {
    repo = await createTestRepo();
    const trees = join(repo.root, "..", "trees");
    process.env.WT_DIR = trees;
    try {
      const worktreePath = await transformToBare(repo.root, "main");

      expect(worktreePath).toBe(join(trees, "main"));
      expect(await detectRepoType(repo.root)).toBe("bare");
      expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(true);
      expect(await Bun.file(join(repo.root, ".worktrees")).exists()).toBe(false);
      expect(await git(["status", "--porcelain"], worktreePath)).toBe("");
    } finally {
      delete process.env.WT_DIR;
    }
  });

  test("preserves a colliding stale worktree admin directory", async () => {
    repo = await createTestRepo();
    await git(["checkout", "-b", "feat/topic"], repo.root);
    const staleAdmin = join(repo.root, ".git", "worktrees", "topic");
    await Bun.write(join(staleAdmin, "sentinel"), "do not overwrite");

    const worktreePath = await transformToBare(repo.root, "feat/topic");

    expect(await Bun.file(join(staleAdmin.replace("/.git/", "/"), "sentinel")).text()).toBe(
      "do not overwrite",
    );
    expect(await Bun.file(join(worktreePath, ".git")).text()).toContain("/worktrees/topic1");
  });
});
