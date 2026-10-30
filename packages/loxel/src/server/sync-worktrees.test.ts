/**
 * Invariant: the worktree list follows `wt` and plain `git worktree` commands, without any action
 * in Loxel. Each test asserts on what a client reads after the events it receives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  executeAdd,
  executeMove,
  executeRemove,
  setWorktreeMeta,
  unsetWorktreeMeta,
} from "@bizimind/wt/lib";

import type { WorktreeEntry } from "@/api/git-models";
import { createSyncRepo, git, SyncProject, type SyncRepo } from "@/test/git-sync-harness";

import { PARENT_KEY, TITLE_KEY } from "./project-worktrees";

const TEST_TIMEOUT_MS = 60_000;

const at = (worktrees: WorktreeEntry[], wtPath: string) =>
  worktrees.find((worktree) => worktree.path === wtPath);

describe.each(["bare", "regular"] as const)("worktree list, %s repo", (layout) => {
  let repo: SyncRepo;
  let project: SyncProject;
  let worktreesDir: string;

  beforeAll(async () => {
    repo = await createSyncRepo(layout);
    worktreesDir = path.join(repo.root, ".worktrees");
    project = await SyncProject.open(repo);
    await project.subscribe(repo.primary);
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    project?.stop();
    repo?.cleanup();
  });

  /** `wt add`, returning the new worktree once a client's list shows it with its id. */
  async function wtAdd(name: string): Promise<WorktreeEntry> {
    const since = project.log.mark();
    const { path: wtPath } = await executeAdd({ name, repoPath: repo.root });
    const worktrees = await project.waitForSidebar(
      (list) => at(list, wtPath)?.wtId !== undefined,
      since,
    );
    return at(worktrees, wtPath)!;
  }

  test(
    "wt add appears with its branch and id",
    async () => {
      const since = project.log.mark();
      const { path: wtPath } = await executeAdd({ name: "added", repoPath: repo.root });

      const worktrees = await project.waitForSidebar(
        (list) => at(list, wtPath)?.wtId !== undefined,
        since,
      );
      expect(at(worktrees, wtPath)).toMatchObject({ branch: "added", wtName: "added" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "wt add with metadata shows the title and parent",
    async () => {
      const parent = await wtAdd("add-parent");

      const since = project.log.mark();
      const { path: wtPath } = await executeAdd({
        name: "add-child",
        repoPath: repo.root,
        meta: { [TITLE_KEY]: "A child", [PARENT_KEY]: parent.wtId! },
      });

      await project.waitForSidebar(
        (list) =>
          at(list, wtPath)?.title === "A child" && at(list, wtPath)?.parentWtId === parent.wtId,
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "wt mv replaces the path and branch",
    async () => {
      const { path: oldPath } = await wtAdd("before-mv");
      const newPath = path.join(worktreesDir, "after-mv");

      const since = project.log.mark();
      await executeMove({ oldName: "before-mv", name: "after-mv", repoPath: repo.root });

      const worktrees = await project.waitForSidebar(
        (list) => at(list, newPath)?.branch === "after-mv" && at(list, oldPath) === undefined,
        since,
      );
      expect(at(worktrees, newPath)?.wtName).toBe("after-mv");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "metadata set and unset with wt meta shows up",
    async () => {
      const { wtId: parentId } = await wtAdd("meta-parent");
      const { path: wtPath } = await wtAdd("meta-child");

      let since = project.log.mark();
      await setWorktreeMeta({
        repoPath: repo.root,
        name: "meta-child",
        values: { [TITLE_KEY]: "Titled" },
      });
      await project.waitForSidebar((list) => at(list, wtPath)?.title === "Titled", since);

      since = project.log.mark();
      await setWorktreeMeta({
        repoPath: repo.root,
        name: "meta-child",
        values: { [PARENT_KEY]: parentId! },
      });
      await project.waitForSidebar((list) => at(list, wtPath)?.parentWtId === parentId, since);

      since = project.log.mark();
      await unsetWorktreeMeta({
        repoPath: repo.root,
        name: "meta-child",
        keys: [TITLE_KEY, PARENT_KEY],
      });
      await project.waitForSidebar(
        (list) =>
          at(list, wtPath)?.title === undefined && at(list, wtPath)?.parentWtId === undefined,
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "wt remove disappears, and the next add still shows up",
    async () => {
      const { path: wtPath } = await wtAdd("removed");

      const since = project.log.mark();
      await executeRemove({
        name: "removed",
        repoPath: repo.root,
        deleteBranch: true,
        force: true,
      });
      await project.waitForSidebar((list) => at(list, wtPath) === undefined, since);

      await wtAdd("after-removed");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "plain git worktree add, move and remove show up",
    async () => {
      const added = path.join(worktreesDir, "plain");
      const moved = path.join(worktreesDir, "plain-moved");

      let since = project.log.mark();
      await git(repo.root, "worktree", "add", "-q", "-b", "plain", added);
      await project.waitForSidebar((list) => at(list, added)?.branch === "plain", since);

      since = project.log.mark();
      await git(repo.root, "worktree", "move", added, moved);
      await project.waitForSidebar(
        (list) => at(list, moved) !== undefined && at(list, added) === undefined,
        since,
      );

      since = project.log.mark();
      await git(repo.root, "worktree", "remove", "--force", moved);
      await project.waitForSidebar((list) => at(list, moved) === undefined, since);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a branch switch in a subscribed worktree reports the new branch",
    async () => {
      const { path: wtPath } = await wtAdd("switch-subscribed");
      await git(wtPath, "branch", "switch-subscribed-target");
      await project.subscribe(wtPath);

      const since = project.log.mark();
      await git(wtPath, "switch", "-q", "switch-subscribed-target");

      await project.waitForStatus(
        wtPath,
        (status) => status.branch === "switch-subscribed-target",
        since,
      );
      project.unsubscribe(wtPath);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "switching to a new branch in an unsubscribed worktree refreshes its dirty entry",
    async () => {
      const { path: wtPath } = await wtAdd("switch-new");
      await Bun.write(path.join(wtPath, "dirty.txt"), "dirty\n");

      const since = project.log.mark();
      await git(wtPath, "switch", "-q", "-c", "switch-new-target");

      await project.waitForMessage(
        "worktree_status_changed",
        (message) =>
          message.data.some(
            (entry) => entry.path === wtPath && entry.branch === "switch-new-target",
          ),
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  // Switching to an existing branch writes only `worktrees/<name>/HEAD` and `index`, which the
  // project watcher ignores. https://github.com/bizimind/loxel/issues/913
  test.todo(
    "switching to an existing branch in an unsubscribed worktree reaches the list and dirty entry",
    async () => {
      const { path: wtPath } = await wtAdd("switch-existing");
      await git(wtPath, "branch", "switch-existing-target");
      await Bun.write(path.join(wtPath, "dirty.txt"), "dirty\n");
      await project.waitForMessage("worktree_status_changed", (message) =>
        message.data.some((entry) => entry.path === wtPath),
      );

      const since = project.log.mark();
      await git(wtPath, "switch", "-q", "switch-existing-target");

      await Promise.all([
        project.waitForSidebar(
          (list) => at(list, wtPath)?.branch === "switch-existing-target",
          since,
        ),
        project.waitForMessage(
          "worktree_status_changed",
          (message) =>
            message.data.some(
              (entry) => entry.path === wtPath && entry.branch === "switch-existing-target",
            ),
          since,
        ),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "everyday git in a worktree does not report a worktree lifecycle change",
    async () => {
      const { path: wtPath } = await wtAdd("quiet");
      const since = await project.settle();

      await Bun.write(path.join(wtPath, "noise.txt"), "noise\n");
      await git(wtPath, "add", "-A");
      await git(wtPath, "commit", "-q", "-m", "noise");
      await git(wtPath, "switch", "-q", "-c", "quiet-other");

      const until = await project.sentinel({ via: "ref" });
      expect(
        project.watchEvents(since, until).filter((entry) => entry.event === "worktrees"),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
