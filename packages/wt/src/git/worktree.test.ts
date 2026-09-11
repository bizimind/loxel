import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { executeAdd } from "../lib/index.ts";
import { createTestRepo, type TestRepo } from "../test-repo.ts";
import { git } from "./run.ts";
import {
  findWorktree,
  getManagedWorktrees,
  getWorktreeName,
  listWorktrees,
  parseWorktreeList,
  pathExists,
  removeSubmoduleWorktreeManually,
  resolveRepoRoot,
  worktreesDir,
  type Worktree,
} from "./worktree.ts";

const wt = (path: string, extra: Partial<Worktree> = {}): Worktree => ({
  path,
  head: "abc",
  branch: null,
  bare: false,
  locked: false,
  ...extra,
});

describe("parseWorktreeList", () => {
  test("parses branches, detached heads, bare and locked entries", () => {
    const output = [
      "worktree /repo",
      "bare",
      "",
      "worktree /repo/.worktrees/feat/foo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/feat/foo",
      "",
      "worktree /repo/.worktrees/loose",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "locked reason goes here",
      "",
    ].join("\n");

    expect(parseWorktreeList(output)).toEqual([
      { path: "/repo", head: "", branch: null, bare: true, locked: false },
      {
        path: "/repo/.worktrees/feat/foo",
        head: "1111111111111111111111111111111111111111",
        branch: "feat/foo",
        bare: false,
        locked: false,
      },
      {
        path: "/repo/.worktrees/loose",
        head: "2222222222222222222222222222222222222222",
        branch: null,
        bare: false,
        locked: true,
      },
    ]);
  });

  test("returns nothing for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("worktreesDir", () => {
  const previous = process.env.WT_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.WT_DIR;
    else process.env.WT_DIR = previous;
  });

  test("defaults to <root>/.worktrees", () => {
    delete process.env.WT_DIR;
    expect(worktreesDir("/repo")).toBe("/repo/.worktrees");
  });

  test("honors an absolute WT_DIR", () => {
    process.env.WT_DIR = "/elsewhere/trees";
    expect(worktreesDir("/repo")).toBe("/elsewhere/trees");
  });

  test("resolves a relative WT_DIR against the repo root", () => {
    process.env.WT_DIR = "../trees";
    expect(worktreesDir("/repo/inner")).toBe("/repo/trees");
  });
});

describe("getWorktreeName", () => {
  test("keeps nested names", () => {
    expect(getWorktreeName("/repo/.worktrees/feat/foo", "/repo/.worktrees")).toBe("feat/foo");
  });

  test("tolerates a trailing slash on the worktrees dir", () => {
    expect(getWorktreeName("/repo/.worktrees/foo", "/repo/.worktrees/")).toBe("foo");
  });

  test("falls back to the last path segment outside the worktrees dir", () => {
    expect(getWorktreeName("/somewhere/else/main", "/repo/.worktrees")).toBe("main");
  });
});

describe("getManagedWorktrees", () => {
  test("keeps only non-bare worktrees under the worktrees dir", () => {
    const worktrees = [
      wt("/repo", { bare: true }),
      wt("/repo/.worktrees/foo"),
      wt("/repo/.worktrees/feat/bar"),
      wt("/outside/baz"),
      wt("/repo/.worktrees/foo/.claude/worktrees/agent-1"),
    ];

    expect(getManagedWorktrees(worktrees, "/repo/.worktrees").map((w) => w.path)).toEqual([
      "/repo/.worktrees/foo",
      "/repo/.worktrees/feat/bar",
    ]);
  });
});

describe("findWorktree", () => {
  const worktrees = [wt("/repo"), wt("/repo/.worktrees/feat/foo")];

  test("finds by nested name", () => {
    expect(findWorktree(worktrees, "/repo/.worktrees", "feat/foo")?.path).toBe(
      "/repo/.worktrees/feat/foo",
    );
  });

  test("does not shorten nested names to a destructive basename match", () => {
    expect(findWorktree(worktrees, "/repo/.worktrees", "foo")).toBeUndefined();
  });

  test("can select one external worktree for non-destructive inspection", () => {
    expect(findWorktree([...worktrees, wt("/outside/foo")], "/repo/.worktrees", "foo")?.path).toBe(
      "/outside/foo",
    );
  });

  test("rejects ambiguous external basenames", () => {
    expect(
      findWorktree(
        [...worktrees, wt("/outside/foo"), wt("/another/foo")],
        "/repo/.worktrees",
        "foo",
      ),
    ).toBeUndefined();
  });

  test("returns undefined for an unknown name", () => {
    expect(findWorktree(worktrees, "/repo/.worktrees", "nope")).toBeUndefined();
  });
});

describe("resolveRepoRoot", () => {
  let repo: TestRepo;

  afterEach(() => repo.cleanup());

  test("resolves the main worktree for a non-bare repo", async () => {
    repo = await createTestRepo();
    expect(await resolveRepoRoot(repo.root)).toBe(repo.root);
    expect(await resolveRepoRoot(join(repo.root, ".git"))).toBe(repo.root);
  });

  test("resolves the git dir for a bare repo", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await resolveRepoRoot(repo.root)).toBe(repo.root);
  });

  test("rejects a directory outside any repository", async () => {
    repo = await createTestRepo();
    await expect(resolveRepoRoot("/")).rejects.toThrow("Not inside a git repository");
  });
});

describe("listWorktrees", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo({ bare: true });
  });
  afterEach(() => repo.cleanup());

  test("reports the bare entry for a fresh bare repo", async () => {
    const worktrees = await listWorktrees(repo.root);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.bare).toBe(true);
  });
});

describe("removeSubmoduleWorktreeManually", () => {
  let repo: TestRepo;

  afterEach(() => repo.cleanup());

  test("removes a checkout and prunes its metadata", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "legacy-git", repoPath: repo.root });

    await removeSubmoduleWorktreeManually(repo.root, added.path);

    expect(await pathExists(added.path)).toBe(false);
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).not.toContain(added.path);
  });

  test("reports partial success when metadata pruning fails", async () => {
    repo = await createTestRepo({ bare: true });
    const target = join(repo.root, "..", "manual-removal-target");
    const notRepo = join(repo.root, "..", "not-a-repository");
    await Bun.write(join(target, "valuable-name"), "contents");
    await Bun.write(join(notRepo, ".keep"), "");

    await expect(removeSubmoduleWorktreeManually(notRepo, target)).rejects.toThrow(
      /Removed .* failed to prune its Git metadata/,
    );
    expect(await pathExists(target)).toBe(false);
  });
});
