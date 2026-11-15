/**
 * Invariant: the commit graph follows git history from any terminal, including commits in worktrees
 * no client has open and changes that arrive from a remote. Each test asserts on what a client
 * reads after the `refs_changed` and `log_changed` it receives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { executeAdd } from "@bizimind/wt/lib";

import { createSyncRepo, git, SyncProject, type SyncRepo } from "@/test/git-sync-harness";

import { getBranchCommits, getRefs } from "./git-commands";

const TEST_TIMEOUT_MS = 60_000;

describe.each(["bare", "regular"] as const)("commit graph, %s repo", (layout) => {
  let repo: SyncRepo;
  let project: SyncProject;
  /** Open in a client. */
  let subscribed: string;
  /** Exists, but no client has it open, so nothing watches its git directory or files. */
  let unsubscribed: string;
  /** A second clone of `origin`, as a teammate's machine. */
  let teammate: string;
  let nextCommit = 0;

  beforeAll(async () => {
    repo = await createSyncRepo(layout);
    teammate = path.join(repo.base, "teammate");
    await git(repo.base, "clone", "-q", repo.remote, teammate);
    await git(teammate, "config", "user.email", "teammate@example.com");
    await git(teammate, "config", "user.name", "Teammate");

    project = await SyncProject.open(repo);
    subscribed = repo.primary;
    unsubscribed = (await executeAdd({ name: "elsewhere", repoPath: repo.root })).path;
    await project.subscribe(subscribed);
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    project?.stop();
    repo?.cleanup();
  });

  /** Commit a new file in `cwd`, as from a terminal, and return the commit's hash. */
  async function commit(cwd: string): Promise<string> {
    const name = `commit-${++nextCommit}.txt`;
    await Bun.write(path.join(cwd, name), "x\n");
    await git(cwd, "add", name);
    await git(cwd, "commit", "-q", "-m", name, "--", name);
    return git(cwd, "rev-parse", "HEAD");
  }

  test(
    "a commit shows in the graph with the branch moved to it",
    async () => {
      const since = project.log.mark();
      const sha = await commit(subscribed);

      const branch = await git(subscribed, "symbolic-ref", "--short", "HEAD");
      await project.waitForGraph(
        ({ shas, refs }) => shas[0] === sha && refs.get(`refs/heads/${branch}`) === sha,
        since,
      );
      await project.waitForMessage("refs_changed", () => true, since);
      await project.waitForMessage("log_changed", () => true, since);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "creating and deleting a branch updates the refs",
    async () => {
      let since = project.log.mark();
      await git(repo.root, "branch", "graph-branch");
      await project.waitForGraph(({ refs }) => refs.has("refs/heads/graph-branch"), since);

      since = project.log.mark();
      await git(repo.root, "branch", "-D", "graph-branch");
      await project.waitForGraph(({ refs }) => !refs.has("refs/heads/graph-branch"), since);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commit in an unsubscribed worktree shows in the graph and its branch commits",
    async () => {
      const since = project.log.mark();
      const sha = await commit(unsubscribed);

      await project.waitForGraph(
        ({ shas, refs }) => shas.includes(sha) && refs.get("refs/heads/elsewhere") === sha,
        since,
      );
      const { commits } = await getBranchCommits(unsubscribed);
      expect(commits.map((entry) => entry.hash)).toContain(sha);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commit in an unsubscribed worktree updates its dirty entry, and removes it once clean",
    async () => {
      const staged = path.join(unsubscribed, "dirty-staged.txt");
      const unstaged = path.join(unsubscribed, "dirty-unstaged.txt");
      await Bun.write(staged, "x\n");
      await Bun.write(unstaged, "x\n");
      await git(unsubscribed, "add", "dirty-staged.txt");

      let since = project.log.mark();
      await git(unsubscribed, "commit", "-q", "-m", "partial", "--", "dirty-staged.txt");
      const sha = await git(unsubscribed, "rev-parse", "HEAD");
      await project.waitForMessage(
        "worktree_status_changed",
        (message) =>
          message.data.some(
            (entry) =>
              entry.path === unsubscribed &&
              entry.commit === sha &&
              entry.untracked.includes("dirty-unstaged.txt"),
          ),
        since,
      );

      since = project.log.mark();
      await git(unsubscribed, "add", "dirty-unstaged.txt");
      await git(unsubscribed, "commit", "-q", "-m", "rest");
      await project.waitForMessage(
        "worktree_status_changed",
        (message) => !message.data.some((entry) => entry.path === unsubscribed),
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a rebase replaces the old commits",
    async () => {
      await git(unsubscribed, "switch", "-q", "-c", "to-rebase", repo.initialCommit);
      const first = await commit(unsubscribed);
      const second = await commit(unsubscribed);
      const baseTip = await commit(subscribed);
      await project.waitForGraph(({ shas }) => shas.includes(baseTip) && shas.includes(second));

      const since = project.log.mark();
      await git(unsubscribed, "rebase", "-q", baseTip);
      const rebased = await git(unsubscribed, "rev-parse", "HEAD");

      await project.waitForGraph(
        ({ shas, refs }) =>
          refs.get("refs/heads/to-rebase") === rebased &&
          shas.includes(rebased) &&
          !shas.includes(first) &&
          !shas.includes(second),
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a fetch brings in a teammate's commits",
    async () => {
      await git(teammate, "switch", "-q", "-c", "from-teammate", "origin/main");
      const sha = await commit(teammate);
      await git(teammate, "push", "-q", "origin", "from-teammate");

      const since = project.log.mark();
      await git(repo.root, "fetch", "-q", "origin");

      await project.waitForGraph(
        ({ shas, refs }) =>
          shas.includes(sha) && refs.get("refs/remotes/origin/from-teammate") === sha,
        since,
      );
      await project.waitForMessage("refs_changed", () => true, since);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a fetch after a teammate's force-push replaces the old remote commit",
    async () => {
      await git(teammate, "switch", "-q", "-c", "force-pushed", "origin/main");
      const before = await commit(teammate);
      await git(teammate, "push", "-q", "origin", "force-pushed");
      let since = project.log.mark();
      await git(repo.root, "fetch", "-q", "origin");
      await project.waitForGraph(({ shas }) => shas.includes(before), since);

      await git(teammate, "commit", "-q", "--amend", "-m", "amended");
      const after = await git(teammate, "rev-parse", "HEAD");
      await git(teammate, "push", "-q", "--force", "origin", "force-pushed");

      since = project.log.mark();
      await git(repo.root, "fetch", "-q", "origin");

      await project.waitForGraph(
        ({ shas, refs }) =>
          refs.get("refs/remotes/origin/force-pushed") === after &&
          shas.includes(after) &&
          !shas.includes(before),
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  // `getRefs` answers from a 2 s cache that no git event clears, and nothing re-reads after the
  // last event of a burst, so the graph's refs stay behind until the next one.
  // https://github.com/bizimind/loxel/issues/432
  test.todo(
    "refs read after a second quick commit reflect that commit",
    async () => {
      let since = project.log.mark();
      const first = await commit(subscribed);
      await project.waitForGraph(({ shas }) => shas.includes(first), since);
      await project.waitForMessage("refs_changed", () => true, since);

      since = project.log.mark();
      const second = await commit(subscribed);
      await project.waitForGraph(({ shas }) => shas.includes(second), since);
      await project.waitForMessage("refs_changed", () => true, since);

      expect((await getRefs(repo.root)).map((ref) => ref.commit)).toContain(second);
    },
    TEST_TIMEOUT_MS,
  );
});
