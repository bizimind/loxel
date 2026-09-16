import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createTestRepo, type TestRepo } from "../test-repo.ts";
import { executeAdd } from "./add.ts";
import { listManagedWorktrees, resolveWorktreesDir } from "./worktrees.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

describe("resolveWorktreesDir", () => {
  test("defaults to <root>/.worktrees for a bare repo", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await resolveWorktreesDir(repo.root)).toBe(join(repo.root, ".worktrees"));
  });

  test("defaults to <root>/.worktrees for a non-bare repo", async () => {
    repo = await createTestRepo();
    expect(await resolveWorktreesDir(repo.root)).toBe(join(repo.root, ".worktrees"));
  });

  test("resolves from inside a linked worktree", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "inner", repoPath: repo.root });
    expect(await resolveWorktreesDir(added.path)).toBe(join(repo.root, ".worktrees"));
  });
});

describe("listManagedWorktrees", () => {
  test("is empty before anything is added", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await listManagedWorktrees(repo.root)).toEqual([]);
  });

  test("names worktrees by their path under the worktrees dir", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "feat/foo", repoPath: repo.root });

    const managed = await listManagedWorktrees(repo.root);
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({ name: "feat/foo", path: added.path, branch: "feat/foo" });
    expect(managed[0]?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("excludes the main worktree of a non-bare repo", async () => {
    repo = await createTestRepo();
    await executeAdd({ name: "side", repoPath: repo.root });

    expect((await listManagedWorktrees(repo.root)).map((wt) => wt.name)).toEqual(["side"]);
  });
});
