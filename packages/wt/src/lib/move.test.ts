import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { branchExists, git, pathExists } from "../git/index.ts";
import { createTestRepo, writeHook, type TestRepo } from "../test-repo.ts";
import { executeAdd } from "./add.ts";
import { executeMove, planMove } from "./move.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

describe("planMove", () => {
  test("plans a directory and branch rename when the two are in sync", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "feat/a", repoPath: repo.root });

    expect(await planMove({ oldName: "feat/a", name: "feat/b", repoPath: repo.root })).toEqual({
      oldName: "feat/a",
      oldPath: added.path,
      oldBranch: "feat/a",
      name: "feat/b",
      worktreePath: join(repo.root, ".worktrees", "feat", "b"),
      newBranch: "feat/b",
      isMain: false,
    });
  });

  test("leaves a diverged branch alone", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "unrelated", "main"], repo.root);
    await executeAdd({ name: "adopted", repoPath: repo.root, branch: "unrelated" });

    const plan = await planMove({ oldName: "adopted", name: "renamed", repoPath: repo.root });
    expect(plan.newBranch).toBeNull();
    expect(plan.branchSkipReason).toBe("diverged");
  });

  test("honours --branch over the new worktree name", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "unrelated", "main"], repo.root);
    await executeAdd({ name: "adopted", repoPath: repo.root, branch: "unrelated" });

    const plan = await planMove({
      oldName: "adopted",
      name: "renamed",
      repoPath: repo.root,
      branch: "explicit",
    });
    expect(plan.newBranch).toBe("explicit");
    expect(plan.branchSkipReason).toBeUndefined();
  });

  test("keepBranch wins over everything", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "kept", repoPath: repo.root });

    const plan = await planMove({
      oldName: "kept",
      name: "renamed",
      repoPath: repo.root,
      keepBranch: true,
    });
    expect(plan.newBranch).toBeNull();
    expect(plan.branchSkipReason).toBe("keep-branch");
  });

  test("reports a detached worktree as having no branch to rename", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "loose", repoPath: repo.root });
    await git(["checkout", "--detach"], added.path);

    const plan = await planMove({ oldName: "loose", name: "renamed", repoPath: repo.root });
    expect(plan.oldBranch).toBeNull();
    expect(plan.newBranch).toBeNull();
    expect(plan.branchSkipReason).toBe("detached");
  });

  test("does not treat the main checkout as a managed worktree", async () => {
    repo = await createTestRepo();
    const name = repo.root.split("/").pop() ?? "";

    await expect(planMove({ oldName: name, name: "renamed", repoPath: repo.root })).rejects.toThrow(
      "No worktrees exist yet",
    );
  });

  test("rejects an invalid new name", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "valid", repoPath: repo.root });

    await expect(
      planMove({ oldName: "valid", name: "../escape", repoPath: repo.root }),
    ).rejects.toThrow("path segments");
  });

  test("rejects an existing destination path", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "one", repoPath: repo.root });
    await executeAdd({ name: "two", repoPath: repo.root });

    await expect(planMove({ oldName: "one", name: "two", repoPath: repo.root })).rejects.toThrow(
      "Path already exists",
    );
  });

  test("rejects renaming to the same name", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "same", repoPath: repo.root });

    await expect(planMove({ oldName: "same", name: "same", repoPath: repo.root })).rejects.toThrow(
      "already at",
    );
  });

  test("rejects a branch name that is already taken", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "src", repoPath: repo.root });
    await git(["branch", "taken", "main"], repo.root);

    await expect(planMove({ oldName: "src", name: "taken", repoPath: repo.root })).rejects.toThrow(
      "Branch 'taken' already exists",
    );
  });

  test("lists available worktrees when the old name is unknown", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "feat/a", repoPath: repo.root });

    await expect(planMove({ oldName: "nope", name: "new", repoPath: repo.root })).rejects.toThrow(
      "feat/a",
    );
  });
});

describe("executeMove", () => {
  test("moves the directory and the branch together", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "feat/a", repoPath: repo.root });

    const result = await executeMove({ oldName: "feat/a", name: "feat/b", repoPath: repo.root });

    expect(result).toEqual({
      name: "feat/b",
      path: join(repo.root, ".worktrees", "feat", "b"),
      branch: "feat/b",
      oldName: "feat/a",
      oldPath: added.path,
      oldBranch: "feat/a",
      moved: true,
      branchRenamed: true,
    });
    expect(await pathExists(added.path)).toBe(false);
    expect(await pathExists(result.path)).toBe(true);
    expect(await branchExists(repo.root, "feat/b")).toBe(true);
    expect(await branchExists(repo.root, "feat/a")).toBe(false);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], result.path)).toBe("feat/b");
  });

  test("works in a non-bare repo and carries uncommitted changes along", async () => {
    repo = await createTestRepo();
    const added = await executeAdd({ name: "dirty", repoPath: repo.root });
    await Bun.write(join(added.path, "scratch.txt"), "note\n");

    const result = await executeMove({ oldName: "dirty", name: "clean", repoPath: repo.root });

    expect(result.branchRenamed).toBe(true);
    expect(await Bun.file(join(result.path, "scratch.txt")).text()).toBe("note\n");
  });

  test("moves the directory only when the branch has diverged", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "unrelated", "main"], repo.root);
    await executeAdd({ name: "adopted", repoPath: repo.root, branch: "unrelated" });

    const messages: string[] = [];
    const result = await executeMove(
      { oldName: "adopted", name: "renamed", repoPath: repo.root },
      { log: (m) => messages.push(m), warn: (m) => messages.push(m) },
    );

    expect(result.branchRenamed).toBe(false);
    expect(result.branch).toBe("unrelated");
    expect(result.oldBranch).toBe("unrelated");
    expect(await branchExists(repo.root, "unrelated")).toBe(true);
    expect(await branchExists(repo.root, "renamed")).toBe(false);
    expect(messages.join("\n")).toContain("leaving it alone");
  });

  test("renames a diverged branch when --branch says so", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "unrelated", "main"], repo.root);
    await executeAdd({ name: "adopted", repoPath: repo.root, branch: "unrelated" });

    const result = await executeMove({
      oldName: "adopted",
      name: "renamed",
      repoPath: repo.root,
      branch: "explicit",
    });

    expect(result.branchRenamed).toBe(true);
    expect(result.branch).toBe("explicit");
    expect(await branchExists(repo.root, "explicit")).toBe(true);
    expect(await branchExists(repo.root, "unrelated")).toBe(false);
  });

  test("keepBranch moves the directory and leaves the branch", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "kept", repoPath: repo.root });

    const result = await executeMove({
      oldName: "kept",
      name: "renamed",
      repoPath: repo.root,
      keepBranch: true,
    });

    expect(result.branchRenamed).toBe(false);
    expect(result.branch).toBe("kept");
    expect(await branchExists(repo.root, "kept")).toBe(true);
  });

  test("moves a detached worktree without touching the ref", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "loose", repoPath: repo.root });
    const head = await git(["rev-parse", "HEAD"], added.path);
    await git(["checkout", "--detach"], added.path);

    const result = await executeMove({ oldName: "loose", name: "renamed", repoPath: repo.root });

    expect(result.branch).toBe("(detached)");
    expect(result.oldBranch).toBe("(detached)");
    expect(result.branchRenamed).toBe(false);
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(head);
    // The branch `add` created is still there, just not checked out.
    expect(await branchExists(repo.root, "loose")).toBe(true);
  });

  test("refuses to resolve the main checkout as a managed worktree", async () => {
    repo = await createTestRepo();
    const name = repo.root.split("/").pop() ?? "";

    await expect(
      executeMove({ oldName: name, name: "renamed", repoPath: repo.root }),
    ).rejects.toThrow("No worktrees exist yet");
  });

  test("force does not bypass Git's submodule move refusal", async () => {
    repo = await createTestRepo({ bare: true });
    const source = await createTestRepo();
    try {
      const added = await executeAdd({ name: "with-submodule", repoPath: repo.root });
      await git(
        ["-c", "protocol.file.allow=always", "submodule", "add", source.root, "vendor/sub"],
        added.path,
      );

      await expect(
        executeMove({ oldName: "with-submodule", name: "moved", repoPath: repo.root, force: true }),
      ).rejects.toThrow("submodules");

      expect(await pathExists(added.path)).toBe(true);
      expect(await pathExists(join(repo.root, ".worktrees", "moved"))).toBe(false);
      expect(await git(["status", "--porcelain"], join(added.path, "vendor/sub"))).toBe("");
    } finally {
      await source.cleanup();
    }
  });

  test("runs rename.wt.sh at the new path with the WT_OLD_* vars", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "hooked", repoPath: repo.root });
    await writeHook(
      repo.root,
      "rename.wt.sh",
      'printf "%s|%s|%s|%s|%s|%s|%s\\n" "$WT_NAME" "$WT_PATH" "$WT_BRANCH" ' +
        '"$WT_OLD_NAME" "$WT_OLD_PATH" "$WT_OLD_BRANCH" "$PWD" > "$WT_PATH/hook.out"',
    );

    const result = await executeMove({ oldName: "hooked", name: "renamed", repoPath: repo.root });

    const line = (await Bun.file(join(result.path, "hook.out")).text()).trim();
    expect(line.split("|")).toEqual([
      "renamed",
      result.path,
      "renamed",
      "hooked",
      added.path,
      "hooked",
      result.path,
    ]);
  });

  test("warns but succeeds when rename.wt.sh fails", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "hooked", repoPath: repo.root });
    await writeHook(repo.root, "rename.wt.sh", "exit 3");

    const warnings: string[] = [];
    const result = await executeMove(
      { oldName: "hooked", name: "renamed", repoPath: repo.root },
      { log: () => {}, warn: (m) => warnings.push(m) },
    );

    expect(result.moved).toBe(true);
    expect(result.branchRenamed).toBe(true);
    expect(warnings.join("\n")).toContain("rename.wt.sh");
  });

  test("leaves no partial state when the preflight rejects the rename", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "src", repoPath: repo.root });
    await git(["branch", "taken", "main"], repo.root);

    await expect(
      executeMove({ oldName: "src", name: "taken", repoPath: repo.root }),
    ).rejects.toThrow("Branch 'taken' already exists");

    expect(await pathExists(added.path)).toBe(true);
    expect(await pathExists(join(repo.root, ".worktrees", "taken"))).toBe(false);
    expect(await branchExists(repo.root, "src")).toBe(true);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], added.path)).toBe("src");
  });

  test("nests and un-nests names, cleaning up nothing behind it", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "flat", repoPath: repo.root });

    const nested = await executeMove({ oldName: "flat", name: "a/b/c", repoPath: repo.root });
    expect(nested.path).toBe(join(repo.root, ".worktrees", "a", "b", "c"));
    expect(nested.branch).toBe("a/b/c");

    const back = await executeMove({ oldName: "a/b/c", name: "flat2", repoPath: repo.root });
    expect(back.path).toBe(join(repo.root, ".worktrees", "flat2"));
    expect(back.branchRenamed).toBe(true);
  });
});
