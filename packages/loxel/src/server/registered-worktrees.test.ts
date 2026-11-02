import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";

import { executeAdd, executeMove, executeRemove } from "@bizimind/wt/lib";

import { createSyncRepo, git, type SyncRepo } from "@/test/git-sync-harness";

import { RegisteredWorktrees } from "./registered-worktrees";

const NO_CHANGES = { removed: [], moved: [], replaced: [] };

describe.each(["bare", "regular"] as const)("RegisteredWorktrees, %s repo", (layout) => {
  let repo: SyncRepo;
  let worktrees: RegisteredWorktrees;

  const add = async (name: string) => (await executeAdd({ name, repoPath: repo.root })).path;

  beforeAll(async () => {
    repo = await createSyncRepo(layout);
    worktrees = new RegisteredWorktrees(repo.root);
    await worktrees.refresh();
  });

  afterAll(() => repo?.cleanup());

  test("adding a worktree or changing git config removes nothing", async () => {
    await add("added");
    expect(await worktrees.refresh()).toEqual(NO_CHANGES);
    await git(repo.root, "config", "--local", "loxel.test", "1");
    expect(await worktrees.refresh()).toEqual(NO_CHANGES);
  });

  test("wt remove counts as removed, once", async () => {
    const wtPath = await add("to-remove");
    await worktrees.refresh();
    await executeRemove({
      name: "to-remove",
      repoPath: repo.root,
      deleteBranch: true,
      force: true,
    });
    expect(await worktrees.refresh()).toEqual({ removed: [wtPath], moved: [], replaced: [] });
    expect(await worktrees.refresh()).toEqual(NO_CHANGES);
  });

  test("git worktree remove counts as removed", async () => {
    const wtPath = await add("plain-remove");
    await worktrees.refresh();
    await git(repo.root, "worktree", "remove", "--force", wtPath);
    expect(await worktrees.refresh()).toEqual({ removed: [wtPath], moved: [], replaced: [] });
  });

  test("wt mv counts as moved, and a later removal is seen at the new path", async () => {
    const from = await add("before-mv");
    await worktrees.refresh();
    const { path: to } = await executeMove({
      oldName: "before-mv",
      name: "after-mv",
      repoPath: repo.root,
    });
    expect(await worktrees.refresh()).toEqual({ removed: [], moved: [{ from, to }], replaced: [] });

    await executeRemove({ name: "after-mv", repoPath: repo.root, deleteBranch: true, force: true });
    expect(await worktrees.refresh()).toEqual({ removed: [to], moved: [], replaced: [] });
  });

  test("removed and added again between two reads counts as replaced, once", async () => {
    const wtPath = await add("again");
    await worktrees.refresh();
    await executeRemove({ name: "again", repoPath: repo.root, deleteBranch: true, force: true });
    await add("again");
    expect(await worktrees.refresh()).toEqual({ removed: [], moved: [], replaced: [wtPath] });
    expect(await worktrees.refresh()).toEqual(NO_CHANGES);
  });

  test("a directory deleted by hand is not removed until git forgets the worktree", async () => {
    const wtPath = await add("by-hand");
    await worktrees.refresh();
    rmSync(wtPath, { recursive: true, force: true });
    expect(await worktrees.refresh()).toEqual(NO_CHANGES);
    await git(repo.root, "worktree", "prune", "--expire", "now");
    expect(await worktrees.refresh()).toEqual({ removed: [wtPath], moved: [], replaced: [] });
  });

  test("a worktree moved out of the managed directory is moved, not removed", async () => {
    const from = await add("leaving");
    await worktrees.refresh();
    const to = path.join(path.dirname(repo.primary), `outside-${layout}`);
    await git(repo.root, "worktree", "move", from, to);
    expect(await worktrees.refresh()).toEqual({ removed: [], moved: [{ from, to }], replaced: [] });
    expect(await worktrees.refresh()).toEqual(NO_CHANGES);
    await git(repo.root, "worktree", "remove", "--force", to);
    expect(await worktrees.refresh()).toEqual({ removed: [to], moved: [], replaced: [] });
  });

  test("a subscribed worktree never seen listed is checked too", async () => {
    const gone = path.join(repo.root, "never-listed");
    expect(await worktrees.refresh([gone])).toEqual({ removed: [gone], moved: [], replaced: [] });
    expect(await worktrees.refresh([repo.primary])).toEqual(NO_CHANGES);
  });

  test("a list that cannot be read reports nothing and forgets nothing", async () => {
    const wtPath = await add("survives");
    await worktrees.refresh();
    const broken = new RegisteredWorktrees(path.join(repo.root, "not-a-repo"));
    expect(broken.refresh()).rejects.toThrow();
    await executeRemove({ name: "survives", repoPath: repo.root, deleteBranch: true, force: true });
    expect(await worktrees.refresh()).toEqual({ removed: [wtPath], moved: [], replaced: [] });
  });
});
