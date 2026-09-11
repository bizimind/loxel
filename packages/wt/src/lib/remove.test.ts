import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { branchExists, git, pathExists } from "../git/index.ts";
import { createTestRepo, writeHook, type TestRepo } from "../test-repo.ts";
import { executeAdd } from "./add.ts";
import { executeRemove, planRemove } from "./remove.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

describe("planRemove", () => {
  test("describes a clean worktree", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "feat/foo", repoPath: repo.root });

    expect(await planRemove({ name: "feat/foo", repoPath: repo.root })).toEqual({
      name: "feat/foo",
      worktreePath: added.path,
      branch: "feat/foo",
      dirty: false,
      isMain: false,
    });
  });

  test("is dirty for a modified file", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "modified", repoPath: repo.root });
    await Bun.write(join(added.path, "README.md"), "# changed\n");

    expect((await planRemove({ name: "modified", repoPath: repo.root })).dirty).toBe(true);
  });

  test("is dirty for an untracked file only", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "untracked", repoPath: repo.root });
    await Bun.write(join(added.path, "scratch.txt"), "note\n");

    expect((await planRemove({ name: "untracked", repoPath: repo.root })).dirty).toBe(true);
  });

  test("does not treat the main checkout as a managed worktree", async () => {
    repo = await createTestRepo();
    const name = repo.root.split("/").pop() ?? "";

    await expect(planRemove({ name, repoPath: repo.root })).rejects.toThrow(
      "No worktrees exist yet",
    );
  });

  test("lists available worktrees when the name is unknown", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "feat/foo", repoPath: repo.root });

    await expect(planRemove({ name: "nope", repoPath: repo.root })).rejects.toThrow("feat/foo");
  });

  test("requires the full canonical name for a nested worktree", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "feat/foo", repoPath: repo.root });

    await expect(planRemove({ name: "foo", repoPath: repo.root })).rejects.toThrow("feat/foo");
    expect(await pathExists(join(repo.root, ".worktrees", "feat", "foo"))).toBe(true);
  });
});

describe("executeRemove", () => {
  test("removes a clean worktree and keeps the branch by default", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "feat/foo", repoPath: repo.root });

    const result = await executeRemove({
      name: "feat/foo",
      repoPath: repo.root,
      deleteBranch: false,
      force: false,
    });

    expect(result).toEqual({
      name: "feat/foo",
      path: added.path,
      removed: true,
      branchDeleted: false,
      hookRan: false,
    });
    expect(await Bun.file(join(added.path, "README.md")).exists()).toBe(false);
    expect(await branchExists(repo.root, "feat/foo")).toBe(true);
  });

  test("deletes the branch when asked", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "doomed", repoPath: repo.root });

    const result = await executeRemove({
      name: "doomed",
      repoPath: repo.root,
      deleteBranch: true,
      force: true,
    });

    expect(result.branchDeleted).toBe(true);
    expect(await branchExists(repo.root, "doomed")).toBe(false);
  });

  test("refuses a dirty worktree without force", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "dirty", repoPath: repo.root });
    await Bun.write(join(added.path, "scratch.txt"), "note\n");

    await expect(
      executeRemove({ name: "dirty", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow("uncommitted or untracked changes");
    expect(await Bun.file(join(added.path, "scratch.txt")).exists()).toBe(true);
  });

  test("removes a dirty worktree with force", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "dirty", repoPath: repo.root });
    await Bun.write(join(added.path, "scratch.txt"), "note\n");

    const result = await executeRemove({
      name: "dirty",
      repoPath: repo.root,
      deleteBranch: false,
      force: true,
    });

    expect(result.removed).toBe(true);
    expect(await Bun.file(join(added.path, "scratch.txt")).exists()).toBe(false);
  });

  test("refuses to resolve the main checkout as a managed worktree", async () => {
    repo = await createTestRepo();
    const name = repo.root.split("/").pop() ?? "";

    await expect(
      executeRemove({ name, repoPath: repo.root, deleteBranch: false, force: true }),
    ).rejects.toThrow("No worktrees exist yet");
  });

  test("does not bypass a worktree lock when force is used for dirty files", async () => {
    const repo = await createTestRepo();
    const created = await executeAdd({ name: "locked", repoPath: repo.root });
    await Bun.write(join(created.path, "dirty.txt"), "keep me");
    await Bun.$`git -C ${repo.root} worktree lock ${created.path}`.quiet();

    await expect(
      executeRemove({ name: "locked", repoPath: repo.root, deleteBranch: false, force: true }),
    ).rejects.toThrow(/locked/i);
    expect(await Bun.file(join(created.path, "dirty.txt")).text()).toBe("keep me");
  });

  test("runs clean.wt.sh before removal, inside the worktree", async () => {
    repo = await createTestRepo({ bare: true });
    await writeHook(repo.root, "clean.wt.sh", 'echo "$WT_NAME at $PWD" >> "$WT_ROOT/cleaned.txt"');
    const added = await executeAdd({ name: "hooked", repoPath: repo.root });

    const result = await executeRemove({
      name: "hooked",
      repoPath: repo.root,
      deleteBranch: false,
      force: false,
    });

    expect(result.hookRan).toBe(true);
    expect((await Bun.file(join(repo.root, "cleaned.txt")).text()).trim()).toBe(
      `hooked at ${added.path}`,
    );
  });

  test("a failing clean.wt.sh warns but still removes", async () => {
    repo = await createTestRepo({ bare: true });
    await writeHook(repo.root, "clean.wt.sh", "exit 1");
    const added = await executeAdd({ name: "hooked", repoPath: repo.root });
    const warnings: string[] = [];

    const result = await executeRemove(
      { name: "hooked", repoPath: repo.root, deleteBranch: false, force: false },
      { log: () => {}, warn: (message) => warnings.push(message) },
    );

    expect(result.removed).toBe(true);
    expect(result.hookRan).toBe(false);
    expect(warnings.join("\n")).toContain("clean.wt.sh exited with code 1");
    expect(await Bun.file(join(added.path, "README.md")).exists()).toBe(false);
  });

  test("deleting an unmerged branch without force warns instead of failing", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "unmerged", repoPath: repo.root });
    await git(["config", "user.email", "test@example.com"], added.path);
    await git(["config", "user.name", "Test"], added.path);
    await Bun.write(join(added.path, "new.txt"), "work\n");
    await git(["add", "."], added.path);
    await git(["commit", "-m", "work"], added.path);
    const warnings: string[] = [];

    const result = await executeRemove(
      { name: "unmerged", repoPath: repo.root, deleteBranch: true, force: false },
      { log: () => {}, warn: (message) => warnings.push(message) },
    );

    expect(result.removed).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(warnings.join("\n")).toContain("could not delete branch 'unmerged'");
    expect(await branchExists(repo.root, "unmerged")).toBe(true);
  });
});

describe("executeRemove with submodules", () => {
  async function repoWithSubmodule(): Promise<{ subUrl: string }> {
    repo = await createTestRepo({ bare: true });
    const subDir = join(repo.root, "..", "submodule-origin");
    await git(["init", "--initial-branch=main", subDir]);
    await git(["config", "user.email", "test@example.com"], subDir);
    await git(["config", "user.name", "Test"], subDir);
    await Bun.write(join(subDir, "tracked.txt"), "v1\n");
    await git(["add", "-A"], subDir);
    await git(["commit", "-m", "initial submodule commit"], subDir);
    return { subUrl: subDir };
  }

  async function addSubmoduleTo(worktreePath: string, subUrl: string): Promise<void> {
    await git(
      ["-c", "protocol.file.allow=always", "submodule", "add", subUrl, "mysub"],
      worktreePath,
    );
    await git(["commit", "-m", "add submodule"], worktreePath);
  }

  test("removes a clean worktree containing a submodule without user force", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "with-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);

    const declined = await git(["worktree", "remove", added.path], repo.root).catch(
      (error: unknown) => error,
    );
    expect(String(declined)).toContain("submodules cannot be moved or removed");
    expect((await planRemove({ name: "with-sub", repoPath: repo.root })).dirty).toBe(false);

    await executeRemove({
      name: "with-sub",
      repoPath: repo.root,
      deleteBranch: false,
      force: false,
    });

    expect(await Bun.file(join(added.path, "mysub", ".git")).exists()).toBe(false);
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).not.toContain(added.path);
  });

  test("requires force for modified submodule contents", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "dirty-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    await Bun.write(join(added.path, "mysub", "tracked.txt"), "modified\n");

    expect((await planRemove({ name: "dirty-sub", repoPath: repo.root })).dirty).toBe(true);
    await expect(
      executeRemove({ name: "dirty-sub", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow(/uncommitted or untracked/i);
  });

  test("detects untracked submodule files even when ignore=all is configured", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "ignored-dirty-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    await git(["config", "submodule.mysub.ignore", "all"], added.path);
    await Bun.write(join(added.path, "mysub", "untracked-secret"), "keep me\n");

    expect(await git(["status", "--porcelain"], added.path)).toBe("");
    expect((await planRemove({ name: "ignored-dirty-sub", repoPath: repo.root })).dirty).toBe(true);
    await expect(
      executeRemove({
        name: "ignored-dirty-sub",
        repoPath: repo.root,
        deleteBranch: false,
        force: false,
      }),
    ).rejects.toThrow(/uncommitted or untracked/i);
    expect(await Bun.file(join(added.path, "mysub", "untracked-secret")).text()).toBe("keep me\n");
  });

  test("does not escalate a locked worktree", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "locked", repoPath: repo.root });
    await git(["worktree", "lock", added.path], repo.root);

    await expect(
      executeRemove({ name: "locked", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow(/lock/i);
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).toContain(added.path);
  });
});
