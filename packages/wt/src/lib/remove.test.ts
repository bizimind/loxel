import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { branchExists, git, pathExists, worktreeStatus } from "../git/index.ts";
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
      localOnlySubmodules: [],
      isMain: false,
      locked: false,
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
    // The empty `feat/` directory must go too, or the name cannot be reused.
    expect(await pathExists(join(repo.root, ".worktrees", "feat"))).toBe(false);
    expect(await pathExists(join(repo.root, ".worktrees"))).toBe(true);
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

  test("refuses a locked worktree before running clean.wt.sh", async () => {
    repo = await createTestRepo({ bare: true });
    await writeHook(repo.root, "clean.wt.sh", 'touch "$WT_ROOT/torn-down"');
    const added = await executeAdd({ name: "locked", repoPath: repo.root });
    await git(["worktree", "lock", added.path], repo.root);

    expect((await planRemove({ name: "locked", repoPath: repo.root })).locked).toBe(true);
    await expect(
      executeRemove({ name: "locked", repoPath: repo.root, deleteBranch: false, force: true }),
    ).rejects.toThrow("git worktree unlock");

    expect(await pathExists(join(repo.root, "torn-down"))).toBe(false);
    expect(await pathExists(added.path)).toBe(true);
  });

  test("does not bypass a worktree lock when force is used for dirty files", async () => {
    repo = await createTestRepo();
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

  test("removes a registered worktree whose checkout disappeared", async () => {
    repo = await createTestRepo({ bare: true });
    await writeHook(repo.root, "clean.wt.sh", "true");
    const added = await executeAdd({ name: "missing", repoPath: repo.root });
    await rm(added.path, { recursive: true });
    const warnings: string[] = [];

    expect((await planRemove({ name: "missing", repoPath: repo.root })).dirty).toBe(false);
    const result = await executeRemove(
      { name: "missing", repoPath: repo.root, deleteBranch: false, force: false },
      { log: () => {}, warn: (message) => warnings.push(message) },
    );

    expect(result.removed).toBe(true);
    expect(result.hookRan).toBe(false);
    expect(warnings.join("\n")).toContain("clean.wt.sh failed to run");
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

  test("force-deletes an unmerged branch with forceBranch", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "unmerged", repoPath: repo.root });
    await git(["config", "user.email", "test@example.com"], added.path);
    await git(["config", "user.name", "Test"], added.path);
    await Bun.write(join(added.path, "new.txt"), "work\n");
    await git(["add", "."], added.path);
    await git(["commit", "-m", "work"], added.path);

    const result = await executeRemove({
      name: "unmerged",
      repoPath: repo.root,
      deleteBranch: true,
      force: false,
      forceBranch: true,
    });

    expect(result.branchDeleted).toBe(true);
    expect(await branchExists(repo.root, "unmerged")).toBe(false);
  });

  test("keeps a sibling worktree's parent directory when pruning", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "feat/one", repoPath: repo.root });
    await executeAdd({ name: "feat/two", repoPath: repo.root });

    await executeRemove({
      name: "feat/one",
      repoPath: repo.root,
      deleteBranch: true,
      force: false,
    });

    expect(await pathExists(join(repo.root, ".worktrees", "feat", "two"))).toBe(true);
    const reused = await executeAdd({ name: "feat/one", repoPath: repo.root });
    expect(reused.created).toBe(true);
  });
});

describe("executeRemove with submodules", () => {
  async function repoWithSubmodule(): Promise<{ subUrl: string }> {
    repo = await createTestRepo({ bare: true });
    const parent = dirname(repo.root);
    const subDir = join(parent, "submodule-origin");
    await git(["init", "--initial-branch=main", subDir], parent);
    await git(["config", "user.email", "test@example.com"], subDir);
    await git(["config", "user.name", "Test"], subDir);
    await Bun.write(join(subDir, "tracked.txt"), "v1\n");
    await git(["add", "-A"], subDir);
    await git(["commit", "-m", "initial submodule commit"], subDir);
    return { subUrl: subDir };
  }

  async function addSubmoduleTo(
    worktreePath: string,
    subUrl: string,
    name = "mysub",
  ): Promise<void> {
    await git(["-c", "protocol.file.allow=always", "submodule", "add", subUrl, name], worktreePath);
    await git(
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "-m",
        "add submodule",
      ],
      worktreePath,
    );
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

  test("refuses to escalate when a submodule holds commits no remote has", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "unpushed-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    const sub = join(added.path, "mysub");
    await Bun.write(join(sub, "tracked.txt"), "v2\n");
    await git(
      ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-am", "local only"],
      sub,
    );
    await git(
      ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-am", "bump"],
      added.path,
    );

    await writeHook(repo.root, "clean.wt.sh", 'touch "$WT_ROOT/clean-ran"');

    const plan = await planRemove({ name: "unpushed-sub", repoPath: repo.root });
    expect(plan.dirty).toBe(false);
    expect(plan.localOnlySubmodules).toEqual(["mysub"]);
    await expect(
      executeRemove({
        name: "unpushed-sub",
        repoPath: repo.root,
        deleteBranch: false,
        force: false,
      }),
    ).rejects.toThrow(/mysub .* has commits no remote has/);
    expect(await Bun.file(join(sub, "tracked.txt")).text()).toBe("v2\n");
    // Refused before the clean hook, so the environment is still up.
    expect(await pathExists(join(repo.root, "clean-ran"))).toBe(false);

    await executeRemove({
      name: "unpushed-sub",
      repoPath: repo.root,
      deleteBranch: false,
      force: true,
    });
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).not.toContain(added.path);
  });

  test("detects changes in a nested submodule hidden by a committed ignore=all", async () => {
    const { subUrl: deepUrl } = await repoWithSubmodule();
    const midUrl = join(dirname(repo.root), "mid-origin");
    await git(["init", "--initial-branch=main", midUrl], dirname(repo.root));
    await git(["-c", "protocol.file.allow=always", "submodule", "add", deepUrl, "deep"], midUrl);
    await git(["config", "-f", ".gitmodules", "submodule.deep.ignore", "all"], midUrl);
    await git(
      ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-am", "add deep"],
      midUrl,
    );

    const added = await executeAdd({ name: "nested-sub", repoPath: repo.root });
    await git(["-c", "protocol.file.allow=always", "submodule", "add", midUrl, "mid"], added.path);
    await git(
      ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
      added.path,
    );
    await git(
      ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-am", "add mid"],
      added.path,
    );
    await Bun.write(join(added.path, "mid", "deep", "precious.txt"), "keep me\n");

    expect(await git(["status", "--porcelain", "--ignore-submodules=none"], added.path)).toBe("");
    expect((await planRemove({ name: "nested-sub", repoPath: repo.root })).dirty).toBe(true);
    await expect(
      executeRemove({ name: "nested-sub", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow(/uncommitted or untracked/i);
    expect(await Bun.file(join(added.path, "mid", "deep", "precious.txt")).exists()).toBe(true);
  });

  test("counts a change inside a submodule once", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "counted-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    await Bun.write(join(added.path, "mysub", "untracked.txt"), "x\n");

    expect(await worktreeStatus(added.path)).toEqual({
      ok: true,
      value: ["?? mysub/untracked.txt"],
    });
  });

  test("counts changes once in a submodule whose path contains a space", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "spaced-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl, "my sub dir");
    await Bun.write(join(added.path, "my sub dir", "untracked.txt"), "x\n");

    expect(await worktreeStatus(added.path)).toEqual({
      ok: true,
      value: ["?? my sub dir/untracked.txt"],
    });
  });

  test("prefixes both halves of a rename inside a submodule", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "renamed-in-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    await git(["mv", "tracked.txt", "renamed.txt"], join(added.path, "mysub"));

    expect(await worktreeStatus(added.path)).toEqual({
      ok: true,
      value: ["R  mysub/tracked.txt -> mysub/renamed.txt"],
    });
  });

  test("fails closed when a submodule's refs cannot be walked", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "broken-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    const sub = join(added.path, "mysub");
    const subGitDir = (await git(["rev-parse", "--path-format=absolute", "--git-dir"], sub)).trim();
    await Bun.write(join(subGitDir, "refs", "heads", "broken"), "0".repeat(40) + "\n");

    // Unverifiable counts as dirty: refused without force, but force stays reachable.
    expect((await planRemove({ name: "broken-sub", repoPath: repo.root })).dirty).toBe(true);
    await expect(
      executeRemove({ name: "broken-sub", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow(/uncommitted or untracked/i);
    expect(await Bun.file(join(sub, "tracked.txt")).exists()).toBe(true);

    await executeRemove({
      name: "broken-sub",
      repoPath: repo.root,
      deleteBranch: false,
      force: true,
    });
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).not.toContain(added.path);
  });

  test("still sees local-only commits of a deinitialized submodule", async () => {
    const { subUrl } = await repoWithSubmodule();
    const added = await executeAdd({ name: "deinit-sub", repoPath: repo.root });
    await addSubmoduleTo(added.path, subUrl);
    const sub = join(added.path, "mysub");
    await Bun.write(join(sub, "tracked.txt"), "v2\n");
    await git(
      ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-am", "local only"],
      sub,
    );
    await git(
      ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-am", "bump"],
      added.path,
    );
    await git(["submodule", "deinit", "-f", "mysub"], added.path);

    expect(await git(["status", "--porcelain", "--ignore-submodules=none"], added.path)).toBe("");
    const plan = await planRemove({ name: "deinit-sub", repoPath: repo.root });
    expect(plan.dirty).toBe(false);
    expect(plan.localOnlySubmodules).toEqual(["mysub"]);
    await expect(
      executeRemove({ name: "deinit-sub", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow(/mysub .* has commits no remote has/);
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).toContain(added.path);
  });

  test("removes a worktree whose modules directory holds no object store", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "empty-modules", repoPath: repo.root });
    const gitDir = (
      await git(["rev-parse", "--path-format=absolute", "--git-dir"], added.path)
    ).trim();
    await mkdir(join(gitDir, "modules"), { recursive: true });

    const declined = await git(["worktree", "remove", added.path], repo.root).catch(
      (error: unknown) => error,
    );
    expect(String(declined)).toContain("submodules cannot be moved or removed");
    await executeRemove({
      name: "empty-modules",
      repoPath: repo.root,
      deleteBranch: false,
      force: false,
    });
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).not.toContain(added.path);
  });

  test("an unreadable status needs force but does not block a forced removal", async () => {
    repo = await createTestRepo({ bare: true });
    const added = await executeAdd({ name: "broken", repoPath: repo.root });
    const gitDir = await git(["rev-parse", "--path-format=absolute", "--git-dir"], added.path);
    await Bun.write(join(gitDir.trim(), "index"), "");

    const plan = await planRemove({ name: "broken", repoPath: repo.root });
    expect(plan.dirty).toBe(true);
    await expect(
      executeRemove({ name: "broken", repoPath: repo.root, deleteBranch: false, force: false }),
    ).rejects.toThrow(/uncommitted or untracked/i);

    await executeRemove({ name: "broken", repoPath: repo.root, deleteBranch: false, force: true });
    expect(await git(["worktree", "list", "--porcelain"], repo.root)).not.toContain(added.path);
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
