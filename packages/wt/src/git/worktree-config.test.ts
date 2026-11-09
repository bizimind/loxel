import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createTestRepo, type TestRepo } from "../test-repo.ts";
import { git, runGit } from "./run.ts";
import {
  disableWorktreeConfigCommands,
  enableWorktreeConfigCommands,
  isWorktreeConfigBroken,
  isWorktreeConfigStranded,
  readWorktreeConfigState,
} from "./worktree-config.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

async function run(commands: string[][], cwd: string): Promise<void> {
  for (const args of commands) await git(args, cwd);
}

async function enable(root: string): Promise<void> {
  await run(enableWorktreeConfigCommands(await readWorktreeConfigState(root)), root);
}

async function disable(root: string): Promise<void> {
  await run(disableWorktreeConfigCommands(await readWorktreeConfigState(root)), root);
}

/** A bare repo with one linked worktree, as wt lays it out. */
async function bareWithWorktree(): Promise<{ root: string; linked: string }> {
  repo = await createTestRepo({ bare: true });
  const linked = join(repo.root, ".worktrees", "feat");
  await git(["worktree", "add", "-b", "feat", linked], repo.root);
  return { root: repo.root, linked };
}

const sharedConfig = (root: string) => Bun.file(join(root, "config")).text();

describe("worktree config in a bare repo", () => {
  test("reproduces the breakage of turning the extension on without moving core.bare", async () => {
    const { root, linked } = await bareWithWorktree();
    await git(["config", "extensions.worktreeConfig", "true"], root);

    const status = await runGit(["status"], linked);
    expect(status.exitCode).not.toBe(0);
    expect(status.stderr).toContain("must be run in a work tree");
    expect(isWorktreeConfigBroken(await readWorktreeConfigState(root))).toBe(true);
  });

  test("enabling moves core.bare into the bare dir's config.worktree", async () => {
    const { root, linked } = await bareWithWorktree();
    await enable(root);

    const state = await readWorktreeConfigState(root);
    expect(state.enabled).toBe(true);
    expect(state.shared).toEqual({});
    expect(state.main).toEqual({ "core.bare": "true" });
    expect(isWorktreeConfigBroken(state)).toBe(false);

    expect(await git(["rev-parse", "--is-bare-repository"], root)).toBe("true");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], linked)).toBe("feat");
    await git(["status"], linked);
  });

  test("keeps per-worktree values separate once enabled", async () => {
    const { root, linked } = await bareWithWorktree();
    await enable(root);

    await git(["config", "--worktree", "wt.parent", "main"], linked);
    expect(await git(["config", "--get", "wt.parent"], linked)).toBe("main");
    expect((await runGit(["config", "--get", "wt.parent"], root)).exitCode).toBe(1);
    expect(await sharedConfig(root)).not.toContain("parent");
  });

  test("enabling is idempotent", async () => {
    const { root } = await bareWithWorktree();
    await enable(root);
    const config = await sharedConfig(root);

    expect(enableWorktreeConfigCommands(await readWorktreeConfigState(root))).toEqual([]);
    await enable(root);
    expect(await sharedConfig(root)).toBe(config);
  });

  test("enabling repairs a repo where the extension is on but core.bare was not moved", async () => {
    const { root, linked } = await bareWithWorktree();
    await git(["config", "extensions.worktreeConfig", "true"], root);

    await enable(root);
    expect(isWorktreeConfigBroken(await readWorktreeConfigState(root))).toBe(false);
    await git(["status"], linked);
  });

  test("disabling restores the original layout and keeps worktrees working", async () => {
    const { root, linked } = await bareWithWorktree();
    await enable(root);
    await git(["config", "--worktree", "wt.parent", "main"], linked);

    const before = await readWorktreeConfigState(root);
    expect(before.worktreeKeys).toEqual([
      { file: join(root, "worktrees", "feat", "config.worktree"), keys: ["wt.parent"] },
    ]);

    await disable(root);
    const after = await readWorktreeConfigState(root);
    expect(after.enabled).toBe(false);
    expect(after.shared).toEqual({ "core.bare": "true" });
    expect(after.main).toEqual({});
    expect(await git(["rev-parse", "--is-bare-repository"], root)).toBe("true");
    await git(["status"], linked);
    // The per-worktree value is left in place but no longer read.
    expect((await runGit(["config", "--get", "wt.parent"], linked)).exitCode).toBe(1);

    expect(disableWorktreeConfigCommands(after)).toEqual([]);
  });

  test("disabling also repairs the broken state", async () => {
    const { root, linked } = await bareWithWorktree();
    await git(["config", "extensions.worktreeConfig", "true"], root);

    await disable(root);
    expect((await readWorktreeConfigState(root)).enabled).toBe(false);
    await git(["status"], linked);
  });

  test("survives an enable/disable/enable round trip", async () => {
    const { root, linked } = await bareWithWorktree();
    await enable(root);
    await disable(root);
    await enable(root);

    const state = await readWorktreeConfigState(root);
    expect(state.shared).toEqual({});
    expect(state.main).toEqual({ "core.bare": "true" });
    await git(["status"], linked);
  });
});

describe("worktree config left half-changed", () => {
  test("restores core.bare when the extension is off but it is only in config.worktree", async () => {
    const { root, linked } = await bareWithWorktree();
    // An enable interrupted after the move, before the extension was switched on.
    const [copy, unset] = enableWorktreeConfigCommands(await readWorktreeConfigState(root));
    await run([copy!, unset!], root);
    const stranded = await readWorktreeConfigState(root);
    expect(isWorktreeConfigStranded(stranded)).toBe(true);

    await disable(root);
    const state = await readWorktreeConfigState(root);
    expect(isWorktreeConfigStranded(state)).toBe(false);
    expect(state.shared).toEqual({ "core.bare": "true" });
    await git(["status"], linked);
  });

  test("is not stranded when core.bare is in both files", async () => {
    const { root } = await bareWithWorktree();
    // An enable that stopped after its first step (the shared config was locked, say).
    const [copy] = enableWorktreeConfigCommands(await readWorktreeConfigState(root));
    await run([copy!], root);

    expect(isWorktreeConfigStranded(await readWorktreeConfigState(root))).toBe(false);
  });

  test("disables over a shared config holding several core.bare lines", async () => {
    const { root, linked } = await bareWithWorktree();
    await enable(root);
    await git(["config", "--file", join(root, "config"), "--add", "core.bare", "false"], root);
    await git(["config", "--file", join(root, "config"), "--add", "core.bare", "false"], root);

    await disable(root);
    expect(
      await git(["config", "--file", join(root, "config"), "--get-all", "core.bare"], root),
    ).toBe("true");
    await git(["status"], linked);
  });
});

describe("worktree config in a regular repo", () => {
  test("enables without touching core.bare = false", async () => {
    repo = await createTestRepo();
    const linked = join(repo.root, ".worktrees", "feat");
    await git(["worktree", "add", "-b", "feat", linked], repo.root);

    expect(enableWorktreeConfigCommands(await readWorktreeConfigState(repo.root))).toEqual([
      ["config", "--file", join(repo.root, ".git", "config"), "extensions.worktreeConfig", "true"],
    ]);
    await enable(repo.root);

    expect(await git(["config", "--get", "core.bare"], repo.root)).toBe("false");
    await git(["status"], linked);
    await git(["status"], repo.root);
  });

  test("moves core.worktree, which would otherwise redirect every linked worktree", async () => {
    repo = await createTestRepo();
    await git(["config", "core.worktree", repo.root], repo.root);
    await git(["config", "extensions.worktreeConfig", "true"], repo.root);
    expect(isWorktreeConfigBroken(await readWorktreeConfigState(repo.root))).toBe(true);

    await enable(repo.root);
    const state = await readWorktreeConfigState(repo.root);
    expect(state.shared).toEqual({});
    expect(state.main).toEqual({ "core.worktree": repo.root });
    expect(await git(["rev-parse", "--show-toplevel"], repo.root)).toBe(repo.root);

    await disable(repo.root);
    expect(await git(["config", "--get", "core.worktree"], repo.root)).toBe(repo.root);
  });
});
