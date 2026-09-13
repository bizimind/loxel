import { afterEach, describe, expect, test } from "bun:test";
import { realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { git } from "../git/index.ts";
import { createTestRepo, writeHook, type TestRepo } from "../test-repo.ts";
import { executeAdd, planAdd } from "./add.ts";
import { listManagedWorktrees, resolveWorktreesDir } from "./worktrees.ts";

let repo: TestRepo;
const previousWtDir = process.env.WT_DIR;

afterEach(async () => {
  if (previousWtDir === undefined) delete process.env.WT_DIR;
  else process.env.WT_DIR = previousWtDir;
  await repo.cleanup();
});

describe("planAdd", () => {
  test("plans a nested worktree under .worktrees", async () => {
    repo = await createTestRepo({ bare: true });

    expect(await planAdd({ name: "feat/foo", repoPath: repo.root })).toEqual({
      name: "feat/foo",
      worktreePath: join(repo.root, ".worktrees", "feat", "foo"),
      branch: "feat/foo",
    });
  });

  test("rejects an invalid name", async () => {
    repo = await createTestRepo();
    await expect(planAdd({ name: "../escape", repoPath: repo.root })).rejects.toThrow(
      "path segments",
    );
  });

  test("reports no conflict when the branch is free", async () => {
    repo = await createTestRepo();
    const plan = await planAdd({ name: "fresh", repoPath: repo.root });
    expect(plan.branchConflict).toBeUndefined();
  });

  test("classifies an existing unused branch as 'exists'", async () => {
    repo = await createTestRepo();
    await git(["branch", "parked"], repo.root);

    const plan = await planAdd({ name: "parked", repoPath: repo.root });
    expect(plan.branchConflict).toEqual({ kind: "exists" });
  });

  test("classifies a checked-out branch as 'used-by-worktree'", async () => {
    repo = await createTestRepo({ bare: true });
    const created = await executeAdd({ name: "taken", repoPath: repo.root });

    const plan = await planAdd({ name: "taken2", repoPath: repo.root });
    expect(plan.branchConflict).toBeUndefined();

    await git(["branch", "-m", "taken", "renamed"], created.path);
    const conflict = await planAdd({ name: "renamed", repoPath: repo.root });
    expect(conflict.branchConflict).toEqual({
      kind: "used-by-worktree",
      worktreePath: created.path,
    });
  });

  test("rejects a name already used by a worktree", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "dup", repoPath: repo.root });

    await expect(planAdd({ name: "dup", repoPath: repo.root })).rejects.toThrow(
      "Worktree 'dup' already exists",
    );
  });
});

describe("executeAdd", () => {
  test("creates a worktree and branch in a bare repo", async () => {
    repo = await createTestRepo({ bare: true });

    const result = await executeAdd({ name: "feat/foo", repoPath: repo.root });

    expect(result).toEqual({
      name: "feat/foo",
      path: join(repo.root, ".worktrees", "feat", "foo"),
      branch: "feat/foo",
      created: true,
      hookRan: false,
    });
    expect(await Bun.file(join(result.path, "README.md")).exists()).toBe(true);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], result.path)).toBe("feat/foo");
  });

  test("creates a worktree in a non-bare repo", async () => {
    repo = await createTestRepo();

    const result = await executeAdd({ name: "side", repoPath: repo.root });

    expect(result.path).toBe(join(repo.root, ".worktrees", "side"));
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], result.path)).toBe("side");
  });

  test("creates a new branch from the invoking linked worktree's HEAD", async () => {
    repo = await createTestRepo();
    const source = await executeAdd({ name: "source", repoPath: repo.root });
    await Bun.write(join(source.path, "source.txt"), "source commit\n");
    await git(["add", "source.txt"], source.path);
    await git(["commit", "-m", "source commit"], source.path);
    const sourceHead = await git(["rev-parse", "HEAD"], source.path);
    expect(sourceHead).not.toBe(await git(["rev-parse", "HEAD"], repo.root));

    const result = await executeAdd({ name: "from-source", repoPath: source.path });

    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(sourceHead);
    expect(await Bun.file(join(result.path, "source.txt")).text()).toBe("source commit\n");
  });

  test("honors WT_DIR", async () => {
    repo = await createTestRepo({ bare: true });
    const elsewhere = join(repo.root, "..", "trees");
    process.env.WT_DIR = elsewhere;

    expect(await resolveWorktreesDir(repo.root)).toBe(elsewhere);
    const result = await executeAdd({ name: "away", repoPath: repo.root });
    expect(result.path).toBe(join(elsewhere, "away"));
  });

  test("canonicalizes a symlinked WT_DIR so created worktrees remain manageable", async () => {
    repo = await createTestRepo({ bare: true });
    const realDir = join(repo.root, "..", "real-trees");
    const linkDir = join(repo.root, "..", "linked-trees");
    await Bun.write(join(realDir, ".keep"), "");
    await symlink(realDir, linkDir);
    process.env.WT_DIR = linkDir;

    expect(await resolveWorktreesDir(repo.root)).toBe(await realpath(realDir));
    const result = await executeAdd({ name: "away", repoPath: repo.root });
    expect(result.path).toBe(join(await realpath(realDir), "away"));
    expect(await listManagedWorktrees(repo.root)).toContainEqual(
      expect.objectContaining({ name: "away", path: result.path }),
    );
  });

  test("checks out an existing branch with an explicit branch", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "existing"], repo.root);

    const result = await executeAdd({ name: "adopt", repoPath: repo.root, branch: "existing" });
    expect(result.branch).toBe("existing");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], result.path)).toBe("existing");
  });

  test("rejects an explicit branch that does not exist", async () => {
    repo = await createTestRepo({ bare: true });
    await expect(
      executeAdd({ name: "nope", repoPath: repo.root, branch: "missing" }),
    ).rejects.toThrow("Branch 'missing' does not exist.");
  });

  test("requires a resolution for an existing branch", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "parked"], repo.root);

    await expect(executeAdd({ name: "parked", repoPath: repo.root })).rejects.toThrow(
      "Provide branchResolution",
    );
  });

  test("reuses an existing branch when told to", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "parked"], repo.root);
    const before = await git(["rev-parse", "parked"], repo.root);

    const result = await executeAdd({
      name: "parked",
      repoPath: repo.root,
      branchResolution: "use-existing",
    });

    expect(result.branch).toBe("parked");
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(before);
  });

  test("recreates an existing branch when told to", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "parked"], repo.root);

    const result = await executeAdd({
      name: "parked",
      repoPath: repo.root,
      branchResolution: "delete-and-create",
    });

    expect(result.branch).toBe("parked");
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(
      await git(["rev-parse", "HEAD"], repo.root),
    );
  });

  test("runs init.wt.sh in the new worktree with hook env", async () => {
    repo = await createTestRepo({ bare: true });
    await writeHook(
      repo.root,
      "init.wt.sh",
      'printf "%s|%s|%s|%s|%s\\n" "$WT_NAME" "$WT_PATH" "$WT_ROOT" "$WT_BRANCH" "$PWD" > hook.txt',
    );

    const result = await executeAdd({ name: "hooked", repoPath: repo.root });

    expect(result.hookRan).toBe(true);
    const recorded = (await Bun.file(join(result.path, "hook.txt")).text()).trim();
    expect(recorded).toBe(["hooked", result.path, repo.root, "hooked", result.path].join("|"));
  });

  test("a failing init.wt.sh warns but keeps the worktree", async () => {
    repo = await createTestRepo({ bare: true });
    await writeHook(repo.root, "init.wt.sh", "exit 3");
    const warnings: string[] = [];

    const result = await executeAdd(
      { name: "broken-hook", repoPath: repo.root },
      { log: () => {}, warn: (message) => warnings.push(message) },
    );

    expect(result.created).toBe(true);
    expect(result.hookRan).toBe(false);
    expect(warnings.join("\n")).toContain("init.wt.sh exited with code 3");
  });
});
