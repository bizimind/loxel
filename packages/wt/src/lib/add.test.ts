import { afterEach, describe, expect, test } from "bun:test";
import { realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { git, pathExists, runGit } from "../git/index.ts";
import type { ProgressHandler } from "../progress.ts";
import {
  createTestRepo,
  enableOriginTracking,
  seedPath,
  writeHook,
  type TestRepo,
} from "../test-repo.ts";
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
      base: "HEAD",
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

  test("keeps a regular repo's status clean by excluding the worktrees dir locally", async () => {
    repo = await createTestRepo();

    await executeAdd({ name: "side", repoPath: repo.root });

    expect(await git(["status", "--porcelain"], repo.root)).toBe("");
    const exclude = await Bun.file(join(repo.root, ".git", "info", "exclude")).text();
    expect(exclude).toContain("/.worktrees/\n");

    // Idempotent: a second add does not append a duplicate entry.
    await executeAdd({ name: "other", repoPath: repo.root });
    const again = await Bun.file(join(repo.root, ".git", "info", "exclude")).text();
    expect(again.split("/.worktrees/").length - 1).toBe(1);
  });

  test("does not touch info/exclude when the worktrees dir is already ignored", async () => {
    repo = await createTestRepo();
    await Bun.write(join(repo.root, ".gitignore"), ".worktrees/\n");
    await git(["add", ".gitignore"], repo.root);
    await git(["commit", "-m", "ignore worktrees"], repo.root);

    await executeAdd({ name: "side", repoPath: repo.root });

    expect(await git(["status", "--porcelain"], repo.root)).toBe("");
    const exclude = await Bun.file(join(repo.root, ".git", "info", "exclude")).text();
    expect(exclude).not.toContain(".worktrees");
  });

  test("without a remote, creates a new branch from the invoking linked worktree's HEAD", async () => {
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
    expect(result.base).toBe("HEAD");
  });

  test("a bare clone without tracking refs uses HEAD silently", async () => {
    repo = await createTestRepo({ bare: true });
    const progress = recordingProgress();

    const result = await executeAdd({ name: "plain", repoPath: repo.root }, progress);

    expect(result.base).toBe("HEAD");
    expect(progress.warnings).toEqual([]);
    expect(progress.logs.some((l) => l.includes("from HEAD"))).toBe(true);
  });

  test("bases a new branch on the remote default as last fetched, without tracking it", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    // Advance the remote and fetch, so origin/main is ahead of the bare HEAD (local main).
    const seed = seedPath(repo.root);
    await Bun.write(join(seed, "remote.txt"), "remote commit\n");
    await git(["add", "remote.txt"], seed);
    await git(["commit", "-m", "remote commit"], seed);
    await git(["fetch", "--quiet", "origin"], repo.root);
    const remoteHead = await git(["rev-parse", "origin/main"], repo.root);
    expect(remoteHead).not.toBe(await git(["rev-parse", "HEAD"], repo.root));

    const result = await executeAdd({ name: "fresh", repoPath: repo.root });

    expect(result.base).toBe("origin/main");
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(remoteHead);
    expect(await Bun.file(join(result.path, "remote.txt")).text()).toBe("remote commit\n");
    // --no-track: the new branch must not adopt origin/main as its upstream.
    expect(await gitConfig(result.path, "branch.fresh.merge")).toBe("");
  });

  test("does not fetch: an unfetched remote commit is not part of the base", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    const fetched = await git(["rev-parse", "origin/main"], repo.root);
    const seed = seedPath(repo.root);
    await Bun.write(join(seed, "later.txt"), "later\n");
    await git(["add", "later.txt"], seed);
    await git(["commit", "-m", "later"], seed);

    const result = await executeAdd({ name: "stale-ok", repoPath: repo.root });

    expect(result.base).toBe("origin/main");
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(fetched);
  });

  test("an explicit base wins over the remote default", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["tag", "pinned", "HEAD"], repo.root);
    const seed = seedPath(repo.root);
    await Bun.write(join(seed, "newer.txt"), "newer\n");
    await git(["add", "newer.txt"], seed);
    await git(["commit", "-m", "newer"], seed);
    await git(["fetch", "--quiet", "origin"], repo.root);
    const pinned = await git(["rev-parse", "pinned"], repo.root);

    const result = await executeAdd({ name: "from-tag", repoPath: repo.root, base: "pinned" });

    expect(result.base).toBe("pinned");
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(pinned);
  });

  test("an explicit remote-tracking base still sets no upstream", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);

    const result = await executeAdd({ name: "explicit", repoPath: repo.root, base: "origin/main" });

    expect(result.base).toBe("origin/main");
    expect(await gitConfig(result.path, "branch.explicit.merge")).toBe("");
  });

  test("rejects a base that does not resolve", async () => {
    repo = await createTestRepo({ bare: true });
    await expect(
      executeAdd({ name: "nowhere", repoPath: repo.root, base: "no-such-ref" }),
    ).rejects.toThrow("invalid reference");
  });

  test("a base starting with a dash is a ref, not an option", async () => {
    repo = await createTestRepo({ bare: true });
    await expect(executeAdd({ name: "dashy", repoPath: repo.root, base: "-q" })).rejects.toThrow();
  });

  test("recreating an existing branch also starts from the base", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["branch", "parked"], repo.root);
    const seed = seedPath(repo.root);
    await Bun.write(join(seed, "ahead.txt"), "ahead\n");
    await git(["add", "ahead.txt"], seed);
    await git(["commit", "-m", "ahead"], seed);
    await git(["fetch", "--quiet", "origin"], repo.root);
    const remoteHead = await git(["rev-parse", "origin/main"], repo.root);

    const result = await executeAdd({
      name: "parked",
      repoPath: repo.root,
      branchResolution: "delete-and-create",
    });

    expect(result.base).toBe("origin/main");
    expect(await git(["rev-parse", "HEAD"], result.path)).toBe(remoteHead);
  });

  test("checking out an existing branch reports no base", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["branch", "existing"], repo.root);

    const result = await executeAdd({ name: "wt", repoPath: repo.root, branch: "existing" });

    expect(result.base).toBeUndefined();
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

  test("a rejected add leaves no empty parent directories behind", async () => {
    repo = await createTestRepo({ bare: true });

    await expect(
      executeAdd({ name: "p/q/r", repoPath: repo.root, branch: "missing" }),
    ).rejects.toThrow("Branch 'missing' does not exist.");

    expect(await pathExists(join(repo.root, ".worktrees", "p"))).toBe(false);
    const later = await executeAdd({ name: "p/q", repoPath: repo.root });
    expect(later.created).toBe(true);
  });

  test("rejects an explicit branch that another worktree has checked out", async () => {
    repo = await createTestRepo({ bare: true });
    const holder = await executeAdd({ name: "holder", repoPath: repo.root });

    await expect(
      executeAdd({ name: "second", repoPath: repo.root, branch: "holder" }),
    ).rejects.toThrow(`Branch 'holder' is already checked out at ${holder.path}`);
    expect(await pathExists(join(repo.root, ".worktrees", "second"))).toBe(false);
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

function recordingProgress(): ProgressHandler & { logs: string[]; warnings: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    logs,
    warnings,
    log: (msg: string) => {
      logs.push(msg);
    },
    warn: (msg: string) => {
      warnings.push(msg);
    },
  };
}

/** A git config value, or "" when unset. */
async function gitConfig(cwd: string, key: string): Promise<string> {
  return (await runGit(["config", "--get", key], cwd)).stdout.trim();
}
