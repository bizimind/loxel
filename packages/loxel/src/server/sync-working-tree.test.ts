/**
 * Invariant: the changes panel (`status_changed`) and the project explorer (`files_dir_changed`)
 * follow edits and git commands from a terminal, and Loxel's own read-only git calls emit nothing.
 * Runs against each kind of worktree that has a different set of watchers behind it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import path from "node:path";

import { executeAdd } from "@bizimind/wt/lib";

import type { DirEntry } from "@/api/project-files-model";
import {
  createSyncRepo,
  git,
  SyncProject,
  type RepoLayout,
  type SyncRepo,
} from "@/test/git-sync-harness";

import {
  getBranchCommits,
  getBranches,
  getLog,
  getRefs,
  getStatus,
  getWorkingTreeDiff,
  readWorktreeStatuses,
} from "./git-commands";

const TEST_TIMEOUT_MS = 60_000;

const CASES: Array<{ title: string; layout: RepoLayout; linked: boolean }> = [
  { title: "linked worktree of a bare repo", layout: "bare", linked: false },
  { title: "root checkout of a regular repo", layout: "regular", linked: false },
  { title: "linked worktree of a regular repo", layout: "regular", linked: true },
];

describe.each(CASES)("working tree, $title", ({ layout, linked }) => {
  let repo: SyncRepo;
  let project: SyncProject;
  let wt: string;
  /** Tests share a checkout, so each uses paths of its own. */
  let nextFile = 0;
  const uniqueName = () => `file-${++nextFile}.txt`;

  beforeAll(async () => {
    repo = await createSyncRepo(layout);
    project = await SyncProject.open(repo);
    wt = repo.primary;
    if (linked) wt = (await executeAdd({ name: "linked", repoPath: repo.root })).path;
    await project.subscribe(wt);
    const files = project.worktrees.get(wt)!.files;
    await files.getDirContents("sub", wt);
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    project?.stop();
    repo?.cleanup();
  });

  const inTree = (name: string) => path.join(wt, name);

  /** A tracked file, committed, with the commit reported and the file listed in the tree. */
  async function commitNewFile(name: string): Promise<void> {
    const since = project.log.mark();
    await Bun.write(inTree(name), "committed\n");
    await git(wt, "add", name);
    await git(wt, "commit", "-q", "-m", `add ${name}`, "--", name);
    const commit = await git(wt, "rev-parse", "HEAD");
    await Promise.all([
      project.waitForStatus(wt, (status) => status.commit === commit, since),
      waitForEntry("", name, (entry) => entry !== undefined, since),
    ]);
  }

  /** Wait for a listing of `dir` (relative to the worktree) whose entry `name` satisfies `match`. */
  function waitForEntry(
    dir: string,
    name: string,
    match: (entry: DirEntry | undefined) => boolean,
    since: number,
  ) {
    return project.waitForMessage(
      "files_dir_changed",
      (message) =>
        message.wtPath === wt &&
        message.data.dir === (dir ? path.join(wt, dir) : wt) &&
        match(message.data.entries.find((entry) => entry.name === name)),
      since,
    );
  }

  test(
    "an edit shows as unstaged, colors the tree and reports the file",
    async () => {
      const name = uniqueName();
      await commitNewFile(name);
      // The commit's own pass reports this file too; its report must not pass for the edit's.
      await project.settle();
      await project.worktrees.get(wt)!.files.refreshGitStatus();

      const since = project.log.mark();
      await Bun.write(inTree(name), "edited\n");

      await Promise.all([
        project.waitForStatus(
          wt,
          (status) => status.unstaged.some((file) => file.path === name && file.status === "M"),
          since,
        ),
        waitForEntry("", name, (entry) => entry?.status === "modified", since),
        project.waitForMessage(
          "file_content_changed",
          (message) => message.data.path === inTree(name),
          since,
        ),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an edit in a subdirectory colors the file and its parent",
    async () => {
      const since = project.log.mark();
      await Bun.write(inTree("sub/b.txt"), `edited ${layout} ${linked}\n`);

      await Promise.all([
        project.waitForStatus(
          wt,
          (status) => status.unstaged.some((file) => file.path === "sub/b.txt"),
          since,
        ),
        waitForEntry("sub", "b.txt", (entry) => entry?.status === "modified", since),
        waitForEntry("", "sub", (entry) => entry?.status === "modified", since),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a new file shows as untracked and appears in the tree",
    async () => {
      const name = uniqueName();
      const since = project.log.mark();
      await Bun.write(inTree(name), "new\n");

      await Promise.all([
        project.waitForStatus(wt, (status) => status.untracked.includes(name), since),
        waitForEntry("", name, (entry) => entry?.status === "untracked", since),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a delete shows as deleted and leaves the tree",
    async () => {
      const name = uniqueName();
      await commitNewFile(name);

      const since = project.log.mark();
      rmSync(inTree(name));

      await Promise.all([
        project.waitForStatus(
          wt,
          (status) => status.unstaged.some((file) => file.path === name && file.status === "D"),
          since,
        ),
        waitForEntry("", name, (entry) => entry === undefined, since),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a rename updates the tree and status, and a tracked file follows it",
    async () => {
      const name = uniqueName();
      const renamed = uniqueName();
      await commitNewFile(name);
      await project.worktrees.get(wt)!.files.trackFile(name);

      const since = project.log.mark();
      renameSync(inTree(name), inTree(renamed));

      await Promise.all([
        project.waitForStatus(
          wt,
          (status) =>
            status.untracked.includes(renamed) &&
            status.unstaged.some((file) => file.path === name && file.status === "D"),
          since,
        ),
        waitForEntry("", renamed, (entry) => entry !== undefined, since),
        project.waitForMessage(
          "file_moved",
          ({ data }) =>
            data.oldPath === inTree(name) &&
            data.newPath === inTree(renamed) &&
            data.source === "external",
          since,
        ),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stage and unstage from a shell move the file between the lists",
    async () => {
      const name = uniqueName();
      await commitNewFile(name);
      await Bun.write(inTree(name), "edited\n");

      let since = project.log.mark();
      await git(wt, "add", name);
      await project.waitForStatus(
        wt,
        (status) =>
          status.staged.some((file) => file.path === name) &&
          !status.unstaged.some((file) => file.path === name),
        since,
      );

      since = project.log.mark();
      await git(wt, "restore", "--staged", name);
      await project.waitForStatus(
        wt,
        (status) =>
          status.unstaged.some((file) => file.path === name) &&
          !status.staged.some((file) => file.path === name),
        since,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commit from a shell clears the file from status and the tree",
    async () => {
      const name = uniqueName();
      await Bun.write(inTree(name), "new\n");
      await git(wt, "add", name);
      await project.waitForStatus(wt, (status) => status.staged.some((file) => file.path === name));

      const since = project.log.mark();
      await git(wt, "commit", "-q", "-m", `add ${name}`, "--", name);
      const commit = await git(wt, "rev-parse", "HEAD");

      await Promise.all([
        project.waitForStatus(
          wt,
          (status) => status.commit === commit && !status.staged.some((file) => file.path === name),
          since,
        ),
        waitForEntry("", name, (entry) => entry?.status === "normal", since),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "git restore of an edit returns the file to clean",
    async () => {
      const name = uniqueName();
      await commitNewFile(name);
      await Bun.write(inTree(name), "edited\n");
      await project.waitForStatus(wt, (status) =>
        status.unstaged.some((file) => file.path === name),
      );

      const since = project.log.mark();
      await git(wt, "restore", name);

      await waitForEntry("", name, (entry) => entry?.status === "normal", since);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    ".gitignore edits update the ignored set, in both directions",
    async () => {
      const name = uniqueName();
      const nested = uniqueName();
      await Bun.write(inTree(name), "x\n");
      await Bun.write(inTree(`sub/${nested}`), "x\n");
      await project.waitForStatus(
        wt,
        (status) => status.untracked.includes(name) && status.untracked.includes(`sub/${nested}`),
      );

      let since = project.log.mark();
      await Bun.write(inTree(".gitignore"), `${name}\n${nested}\n`);
      await Promise.all([
        project.waitForStatus(wt, (status) => !status.untracked.includes(name), since),
        waitForEntry("", name, (entry) => entry?.status === "ignored", since),
        waitForEntry("sub", nested, (entry) => entry?.status === "ignored", since),
      ]);

      since = project.log.mark();
      rmSync(inTree(".gitignore"));
      await Promise.all([
        project.waitForStatus(wt, (status) => status.untracked.includes(name), since),
        waitForEntry("", name, (entry) => entry?.status === "untracked", since),
        waitForEntry("sub", nested, (entry) => entry?.status === "untracked", since),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ignoring a directory in .gitignore marks it, and lifting that restores it",
    async () => {
      await Bun.write(inTree("build-output/out.txt"), "x\n");
      let since = project.log.mark();
      await Bun.write(inTree(".gitignore"), "build-output/\n");
      await waitForEntry("", "build-output", (entry) => entry?.status === "ignored", since);

      since = project.log.mark();
      rmSync(inTree(".gitignore"));
      await waitForEntry("", "build-output", (entry) => entry?.status === "untracked", since);
      rmSync(inTree("build-output"), { recursive: true });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Loxel's own read-only git calls emit no watcher events",
    async () => {
      const files = project.worktrees.get(wt)!.files;
      // A tracked file edited since the index was written is what makes git want to rewrite the
      // index on a read. The one read allowed to do so once (see WATCHERS.md) goes before the base.
      const name = uniqueName();
      await commitNewFile(name);
      await Bun.write(inTree(name), "edited\n");
      await getWorkingTreeDiff(repo.root, wt);
      const since = await project.settle();

      for (let round = 0; round < 3; round++) {
        await Bun.write(inTree(name), `edited ${round}\n`);
        await Promise.all([
          getStatus(wt),
          files.refreshGitStatus(),
          readWorktreeStatuses(repo.root),
          getRefs(repo.root),
          getLog(repo.root, { all: true }),
          getBranchCommits(wt),
          getBranches(repo.root),
        ]);
        // Spaces the rounds: FSEvents coalesces a burst and can hide a write. Emits worktrees only.
        await project.sentinel({ via: "config" });
      }

      const until = await project.sentinel({ via: "config" });
      expect(
        project.watchEvents(since, until).filter((entry) => entry.event !== "worktrees"),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("working tree, bare repo layout", () => {
  let repo: SyncRepo;
  let project: SyncProject;

  beforeAll(async () => {
    repo = await createSyncRepo("bare");
    project = await SyncProject.open(repo);
    await project.subscribe(repo.primary);
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    project?.stop();
    repo?.cleanup();
  });

  test(
    "source edits inside .worktrees reach the project watcher as nothing",
    async () => {
      const since = await project.settle();

      // The working trees live inside the recursively watched bare repo, under paths that would
      // look like git metadata if the classification rules were not anchored.
      await Bun.write(path.join(repo.primary, "refs/heads/not-a-ref"), "x\n");
      await Bun.write(path.join(repo.primary, "objects/ab/not-an-object"), "x\n");
      await Bun.write(path.join(repo.primary, "plain-source.ts"), "x\n");
      await Bun.write(path.join(repo.primary, "node_modules/p/index.js"), "x\n");

      await project.waitForStatus(repo.primary, (status) => status.untracked.includes("refs/"));
      const sentinel = await project.sentinel({ via: "config" });
      expect(
        project
          .watchEvents(since, sentinel)
          .filter((entry) => entry.source === "project" && entry.event !== "worktrees"),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
