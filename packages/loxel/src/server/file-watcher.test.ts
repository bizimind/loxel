import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CaptureLog, retryUntil } from "@/test/git-sync-harness";

import type { WatchEvent } from "./file-watcher";
import { classifyGitChange, FileWatcher } from "./file-watcher";
import { getStatus, getWorkingTreeDiff, readWorktreeStatuses } from "./git-commands";
import { ProjectFilesService } from "./project-files-service";

describe("classifyGitChange", () => {
  // A `X.lock` event must classify as `X`. FSEvents often reports only the lock name for an
  // operation (`git tag` surfaces nothing but `refs/tags/v9.lock`), so ignoring locks meant
  // ignoring the operation.
  test.each([
    { file: "index.lock", expected: ["status"] as WatchEvent[] },
    { file: "refs/heads/main.lock", expected: ["refs", "log"] as WatchEvent[] },
    { file: "HEAD.lock", expected: ["refs", "log"] as WatchEvent[] },
    { file: "refs/tags/v9.lock", expected: ["refs", "log"] as WatchEvent[] },
    { file: "packed-refs.lock", expected: ["refs"] as WatchEvent[] },
    { file: "AUTO_MERGE.lock", expected: ["status"] as WatchEvent[] },
  ])("lock file classifies as its base path: $file", ({ file, expected }) => {
    expect(classifyGitChange(file)).toEqual(expected);
  });

  test("index change emits status", () => {
    expect(classifyGitChange("index")).toEqual(["status"]);
  });

  test("HEAD emits refs + log", () => {
    expect(classifyGitChange("HEAD")).toEqual(["refs", "log"]);
  });

  test("ORIG_HEAD emits refs, log, status (matches both HEAD and _HEAD rules)", () => {
    const events = classifyGitChange("ORIG_HEAD");
    expect(events).toContain("refs");
    expect(events).toContain("log");
    expect(events).toContain("status");
  });

  test.each([
    { file: "refs/heads/main", expected: ["refs", "log"] as WatchEvent[] },
    { file: "refs/heads/feature/foo", expected: ["refs", "log"] as WatchEvent[] },
    { file: "refs/tags/v1.0", expected: ["refs", "log"] as WatchEvent[] },
  ])("branch/tag ref $file emits refs + log", ({ file, expected }) => {
    expect(classifyGitChange(file)).toEqual(expected);
  });

  test("remote ref emits refs only (no log)", () => {
    const events = classifyGitChange("refs/remotes/origin/main");
    expect(events).toContain("refs");
    expect(events).not.toContain("log");
  });

  test("packed-refs emits refs", () => {
    expect(classifyGitChange("packed-refs")).toEqual(["refs"]);
  });

  test.each([
    { file: "FETCH_HEAD", expected: ["status", "refs"] as WatchEvent[] },
    { file: "MERGE_HEAD", expected: ["status", "refs"] as WatchEvent[] },
    { file: "CHERRY_PICK_HEAD", expected: ["status", "refs"] as WatchEvent[] },
  ])("$file emits status + refs", ({ file, expected }) => {
    expect(classifyGitChange(file)).toEqual(expected);
  });

  test.each([
    { file: "refs/stash", containsStatus: true },
    { file: "logs/refs/stash", containsStatus: true },
    { file: "logs/refs/stash/extra", containsStatus: true },
  ])("stash file $file emits status", ({ file }) => {
    expect(classifyGitChange(file)).toContain("status");
  });

  test("worktree gitdir emits worktrees", () => {
    expect(classifyGitChange("worktrees/my-worktree/gitdir")).toEqual(["worktrees"]);
  });

  test("worktree commondir emits worktrees", () => {
    expect(classifyGitChange("worktrees/my-worktree/commondir")).toEqual(["worktrees"]);
  });

  test.each([
    "worktrees/my-worktree/config.worktree",
    "worktrees/my-worktree/config.worktree.lock",
    "config",
    "config.lock",
    "config.worktree",
  ])("worktree metadata file %s emits worktrees", (file) => {
    expect(classifyGitChange(file)).toEqual(["worktrees"]);
  });

  test("worktree lock file emits nothing", () => {
    expect(classifyGitChange("worktrees/my-worktree/index.lock")).toEqual([]);
  });

  test("worktree non-gitdir file emits nothing", () => {
    expect(classifyGitChange("worktrees/my-worktree/HEAD")).not.toContain("worktrees");
  });

  // Seen through the PARENT repo's common-dir watch these are noise: the linked worktree has
  // its own FileWatcher rooted at `worktrees/<name>/`, where the same files arrive
  // start-anchored as `index`/`HEAD`/`logs/HEAD` and classify correctly.
  test.each([
    "worktrees/my-worktree/HEAD",
    "worktrees/my-worktree/index",
    "worktrees/my-worktree/index.lock",
    "worktrees/my-worktree/ORIG_HEAD",
    "worktrees/my-worktree/logs/HEAD",
    "worktrees/my-worktree/refs/bisect/bad",
  ])("per-worktree churn %s emits nothing", (file) => {
    expect(classifyGitChange(file)).toEqual([]);
  });

  test("AUTO_MERGE emits status", () => {
    expect(classifyGitChange("AUTO_MERGE")).toEqual(["status"]);
  });

  test.each(["logs/HEAD", "logs/refs/heads/main", "logs/refs/tags/v1"])(
    "reflog %s emits refs + log",
    (file) => {
      expect(classifyGitChange(file)).toEqual(["refs", "log"]);
    },
  );

  test("remote reflog emits refs only", () => {
    expect(classifyGitChange("logs/refs/remotes/origin/main")).toEqual(["refs"]);
  });

  // Object writes are sometimes the ONLY thing FSEvents surfaces for a commit, and the path
  // says nothing about what kind of change it was — hence all three refreshes.
  test.each(["objects/93/1c4f2a0b", "objects/pack/pack-abc.idx", "objects/pack/pack-abc.pack"])(
    "object write %s emits status + refs + log",
    (file) => {
      expect(classifyGitChange(file)).toEqual(["status", "refs", "log"]);
    },
  );

  test.each([
    "hooks/pre-commit",
    "info/exclude",
    "description",
    "COMMIT_EDITMSG",
    "fsmonitor--daemon.ipc",
    "fsmonitor--daemon.ipc.lock",
    "fsmonitor--daemon/cookies/1234-1",
  ])("unknown git-dir file %s emits nothing", (file) => {
    expect(classifyGitChange(file)).toEqual([]);
  });

  // For a BARE repo the git dir, common dir and repo root are the same directory and the
  // working trees live at `<repo>/.worktrees/`, inside the recursive watch. Every rule is
  // anchored at the start of the path so worktree contents cannot match.
  test.each([
    ".worktrees/foo/src/a.ts",
    ".worktrees/foo/objects/x",
    ".worktrees/foo/node_modules/p/index.js",
    ".worktrees/foo/index",
    ".worktrees/foo/HEAD",
    ".worktrees/foo/refs/heads/main",
    ".worktrees/foo/logs/HEAD",
    ".worktrees/foo/MERGE_HEAD",
    ".worktrees/foo/packed-refs",
    "src/server/file-watcher.ts",
  ])("bare-repo working tree path %s emits nothing", (file) => {
    expect(classifyGitChange(file)).toEqual([]);
  });
});

/**
 * A started watcher whose native watches have proven live, with what it emits captured. A native
 * watch misses what happens before it arms and nothing signals that it has, so a config write is
 * repeated until one is delivered. `git config` emits `worktrees` and nothing else.
 */
async function startArmed(gitRoot: string, debounceMs: number, cleanups: Array<() => void>) {
  const log = new CaptureLog<WatchEvent>();
  const watcher = new FileWatcher({ gitRoot, debounceMs, onEvent: (event) => log.add(event) });
  cleanups.push(() => watcher.stop());
  await watcher.start();
  await armed(gitRoot, log);
  return { log, watcher };
}

async function armed(gitRoot: string, log: CaptureLog<WatchEvent>): Promise<void> {
  const since = log.mark();
  await retryUntil(
    async (attempt) => {
      await Bun.$`git -C ${gitRoot} config --local loxel.test-probe ${String(attempt)}`.quiet();
    },
    (timeoutMs) => log.seenWithin((event) => event === "worktrees", since, timeoutMs),
    "the watcher to arm",
  );
}

/**
 * Emit `worktrees` through `git config` and wait for it. Everything caused by earlier operations
 * has reached the log by then: events are delivered in order and debounced alike.
 */
async function configSentinel(gitRoot: string, log: CaptureLog<WatchEvent>): Promise<number> {
  const since = log.mark();
  await Bun.$`git -C ${gitRoot} config --local loxel.test-sentinel ${String(since)}`.quiet();
  return log.waitFor((event) => event === "worktrees", { since, label: "the config sentinel" });
}

/**
 * Emit `refs` and `log` through a new tag, and wait for them. Tags twice, as earlier operations may
 * emit `log` themselves: the first tag's event may be taken for theirs, but the second's cannot.
 */
async function refSentinel(gitRoot: string, log: CaptureLog<WatchEvent>): Promise<number> {
  let seq = -1;
  for (let tag = 0; tag < 2; tag++) {
    const since = log.mark();
    await Bun.$`git -C ${gitRoot} tag ${`sentinel-${since}-${tag}`}`.quiet();
    seq = await log.waitFor((event) => event === "log", { since, label: "the ref sentinel" });
  }
  return seq;
}

/** A position after everything already done, for a negative assertion from a clean base. */
async function settled(gitRoot: string, log: CaptureLog<WatchEvent>): Promise<number> {
  await configSentinel(gitRoot, log);
  await refSentinel(gitRoot, log);
  return log.mark();
}

const notWorktrees = (event: WatchEvent) => event !== "worktrees";

/** The sentinels write to the git dir, and a test of what git does to `worktrees/` cannot have that. */
const NO_SETTLE = { settle: false };

/**
 * Integration coverage for the `<commonDir>/worktrees` directory watch.
 *
 * These drive real `git worktree` commands against a real repo because the bug they guard
 * against lives entirely in what macOS FSEvents chooses to report — it is invisible to any
 * test that only calls classifyGitChange.
 */
describe("FileWatcher worktree lifecycle", () => {
  const SCRATCH = tmpdir();
  const DEBOUNCE_MS = 150;

  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function makeRepo() {
    mkdirSync(SCRATCH, { recursive: true });
    const base = mkdtempSync(path.join(SCRATCH, "fw-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));

    const repo = path.join(base, "repo");
    mkdirSync(repo);
    await Bun.$`git -C ${repo} init -q -b main`.quiet();
    await Bun.$`git -C ${repo} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();

    return { base, repo };
  }

  /**
   * Run `action` and wait for the `worktrees` event it causes. With `settle: false`, for a test
   * where any write to the git dir before the action would change what it exercises, the wait can
   * also be satisfied by a late event of the action before.
   */
  async function expectWorktreesEvent(
    log: CaptureLog<WatchEvent>,
    repo: string,
    action: () => Promise<unknown>,
    label: string,
    { settle = true }: { settle?: boolean } = {},
  ) {
    const since = settle ? await settled(repo, log) : log.mark();
    await action();
    await log.waitFor((event) => event === "worktrees", { since, label: `worktrees on ${label}` });
  }

  test("fires on add and remove when worktrees/ already exists", async () => {
    const { base, repo } = await makeRepo();

    // Create and drop a throwaway worktree so `.git/worktrees` exists before start().
    const warmup = path.join(base, "warmup");
    await Bun.$`git -C ${repo} worktree add -q -b warmup ${warmup}`.quiet();
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(true);

    const { log } = await startArmed(repo, DEBOUNCE_MS, cleanups);

    const added = path.join(base, "added");
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree add -q -b added ${added}`.quiet(),
      "add",
    );
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree remove --force ${added}`.quiet(),
      "remove",
    );

    await Bun.$`git -C ${repo} worktree remove --force ${warmup}`.quiet();
  }, 60000);

  test("fires on the first-ever worktree, when worktrees/ is absent at start()", async () => {
    const { base, repo } = await makeRepo();
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(false);

    const { log } = await startArmed(repo, DEBOUNCE_MS, cleanups);

    const first = path.join(base, "first");
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree add -q -b first ${first}`.quiet(),
      "add",
    );

    // The lazy attach should now be live, so removal is observed too.
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree remove --force ${first}`.quiet(),
      "remove",
    );
  }, 60000);

  test("keeps reporting removals after git deletes and recreates worktrees/", async () => {
    const { base, repo } = await makeRepo();
    const { log } = await startArmed(repo, DEBOUNCE_MS, cleanups);

    // Removing the only worktree makes git delete `.git/worktrees` outright, which kills the
    // directory watcher without any event. The next add must re-arm it.
    const a = path.join(base, "a");
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree add -q -b a ${a}`.quiet(),
      "add a",
      NO_SETTLE,
    );
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree remove --force ${a}`.quiet(),
      "remove a",
      NO_SETTLE,
    );
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(false);

    const b = path.join(base, "b");
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree add -q -b b ${b}`.quiet(),
      "add b",
      NO_SETTLE,
    );
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree remove --force ${b}`.quiet(),
      "remove b",
      NO_SETTLE,
    );
  }, 60000);

  test("survives git reusing the worktrees/ inode across remove and re-add cycles", async () => {
    const { base, repo } = await makeRepo();
    // Pre-created branches: `worktree add <path> <branch>` writes nothing before mkdir, so the
    // freed inode is the first one handed back. A new-branch add would mask the reuse.
    for (const b of ["b1", "b2", "b3"]) await Bun.$`git -C ${repo} branch ${b}`.quiet();
    const { log } = await startArmed(repo, DEBOUNCE_MS, cleanups);

    for (const b of ["b1", "b2", "b3"]) {
      const wt = path.join(base, b);
      await expectWorktreesEvent(
        log,
        repo,
        () => Bun.$`git -C ${repo} worktree add -q ${wt} ${b}`.quiet(),
        `add ${b}`,
        NO_SETTLE,
      );
      await expectWorktreesEvent(
        log,
        repo,
        () => Bun.$`git -C ${repo} worktree remove --force ${wt}`.quiet(),
        `remove ${b}`,
        NO_SETTLE,
      );
    }
  }, 90000);

  test("commits inside a worktree do not emit worktrees", async () => {
    const { base, repo } = await makeRepo();
    const wt = path.join(base, "noisy");
    await Bun.$`git -C ${repo} worktree add -q -b noisy ${wt}`.quiet();

    const { log } = await startArmed(repo, DEBOUNCE_MS, cleanups);
    const since = await settled(repo, log);

    await Bun.write(path.join(wt, "a.txt"), "a");
    await Bun.$`git -C ${wt} add -A`.quiet();
    await Bun.$`git -C ${wt} -c user.email=t@t -c user.name=t commit -q -m noise`.quiet();
    await Bun.$`git -C ${wt} checkout -q -b other`.quiet();

    const until = await refSentinel(repo, log);
    expect(log.slice(since, until)).not.toContain("worktrees");
  }, 60000);

  test("stop() closes delivery and start() restores it without duplicate watchers", async () => {
    const { base, repo } = await makeRepo();
    const wt = path.join(base, "w");
    await Bun.$`git -C ${repo} worktree add -q -b w ${wt}`.quiet();

    const { log, watcher } = await startArmed(repo, DEBOUNCE_MS, cleanups);
    await watcher.start(); // second call must not double-watch
    // Still running after the stop below, to say when the removal has been delivered.
    const { log: observer } = await startArmed(repo, DEBOUNCE_MS, cleanups);
    watcher.stop();

    const since = log.mark();
    await expectWorktreesEvent(
      observer,
      repo,
      () => Bun.$`git -C ${repo} worktree remove --force ${wt}`.quiet(),
      "remove",
    );
    expect(log.slice(since)).toEqual([]);

    await watcher.start();
    await armed(repo, log);
    const afterRestart = path.join(base, "after-restart");
    await expectWorktreesEvent(
      log,
      repo,
      () => Bun.$`git -C ${repo} worktree add -q -b after-restart ${afterRestart}`.quiet(),
      "add after restart",
    );
    await Bun.$`git -C ${repo} worktree remove --force ${afterRestart}`.quiet();
  }, 60000);
});

/**
 * End-to-end coverage for live status/refs/log updates.
 *
 * The bug these guard against was completely invisible to the unit suite above: every rule in
 * classifyGitChange was individually correct, but macOS FSEvents never reported the filenames
 * those rules matched. Only a real repo driving real git commands exercises the coalescing
 * behaviour.
 */
describe("FileWatcher live git updates", () => {
  const SCRATCH = tmpdir();
  const DEBOUNCE_MS = 100;

  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function scratchDir(prefix: string) {
    mkdirSync(SCRATCH, { recursive: true });
    const dir = mkdtempSync(path.join(SCRATCH, prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function seedRepo(repo: string) {
    mkdirSync(repo, { recursive: true });
    await Bun.$`git -C ${repo} init -q -b main`.quiet();
    await Bun.$`git -C ${repo} config user.email t@t`.quiet();
    await Bun.$`git -C ${repo} config user.name t`.quiet();
    await Bun.write(path.join(repo, "a.txt"), "one\n");
    await Bun.$`git -C ${repo} add -A`.quiet();
    await Bun.$`git -C ${repo} commit -q -m init`.quiet();
    return repo;
  }

  const startWatcher = (gitRoot: string) => startArmed(gitRoot, DEBOUNCE_MS, cleanups);

  /**
   * Run `round` several times, each followed by a sentinel round trip, and assert that none emitted
   * anything. The spacing matters: FSEvents coalesces a burst into a nondeterministic subset of
   * filenames, so a single burst reports the offending `index.lock` only some of the time.
   */
  async function expectSilentRounds(
    gitRoot: string,
    log: CaptureLog<WatchEvent>,
    rounds: number,
    round: (index: number) => Promise<unknown>,
  ) {
    const since = await settled(gitRoot, log);
    for (let index = 0; index < rounds; index++) {
      await round(index);
      await configSentinel(gitRoot, log);
    }
    expect(log.slice(since).filter(notWorktrees)).toEqual([]);

    // The sentinel above hides `worktrees` events, so one more round behind a different sentinel.
    const beforeLast = await settled(gitRoot, log);
    await round(rounds);
    expect(log.slice(beforeLast, await refSentinel(gitRoot, log))).not.toContain("worktrees");
  }

  test("every common git operation produces at least one event", async () => {
    const base = scratchDir("live-");
    const repo = await seedRepo(path.join(base, "repo"));
    const { log } = await startWatcher(repo);

    // One repo, run sequentially: each step only counts what follows its own sentinel. Splitting
    // these into separate tests would multiply FSEvents arm time by six for no extra coverage.
    const steps: Array<[string, () => Promise<unknown>]> = [
      [
        "add",
        async () => {
          await Bun.write(path.join(repo, "b.txt"), "b\n");
          await Bun.$`git -C ${repo} add b.txt`.quiet();
        },
      ],
      ["commit", () => Bun.$`git -C ${repo} commit -q -m second`.quiet()],
      ["branch", () => Bun.$`git -C ${repo} branch topic`.quiet()],
      ["checkout", () => Bun.$`git -C ${repo} checkout -q topic`.quiet()],
      ["tag", () => Bun.$`git -C ${repo} tag v9`.quiet()],
      [
        "stash",
        async () => {
          await Bun.write(path.join(repo, "a.txt"), "dirty\n");
          await Bun.$`git -C ${repo} stash push -q`.quiet();
        },
      ],
      [
        "reset --hard",
        async () => {
          await Bun.write(path.join(repo, "a.txt"), "dirty again\n");
          await Bun.$`git -C ${repo} reset -q --hard HEAD`.quiet();
        },
      ],
      ["branch -D", () => Bun.$`git -C ${repo} branch -D main`.quiet()],
    ];

    for (const [label, run] of steps) {
      const since = (await configSentinel(repo, log)) + 1;
      await run();
      await log.waitFor(notWorktrees, { since, label: `an event from git ${label}` });
    }
  }, 180000);

  test("repeated read-only getStatus calls produce no events", async () => {
    const base = scratchDir("ro-");
    const repo = await seedRepo(path.join(base, "repo"));

    // A dirty working tree is the case that used to loop: git rewrites the index on every
    // status refresh, so `index.lock` churned once per call.
    await Bun.write(path.join(repo, "dirty.txt"), "x\n");
    const { log } = await startWatcher(repo);

    await expectSilentRounds(repo, log, 6, async (round) => {
      await Bun.write(path.join(repo, "dirty.txt"), `round ${round}\n`);
      await getStatus(repo);
    });
  }, 120000);

  test("file-tree status refreshes produce no git-directory events", async () => {
    const base = scratchDir("file-tree-ro-");
    const repo = await seedRepo(path.join(base, "repo"));
    await Bun.write(path.join(repo, "dirty.txt"), "x\n");

    const { log } = await startWatcher(repo);
    const filesService = new ProjectFilesService(repo, () => {});

    await expectSilentRounds(repo, log, 6, async (round) => {
      await Bun.write(path.join(repo, "dirty.txt"), `round ${round}\n`);
      await filesService.refreshGitStatus();
    });
  }, 120000);

  test("readWorktreeStatuses over several worktrees produces no events", async () => {
    const base = scratchDir("dirty-");
    const repo = await seedRepo(path.join(base, "repo"));

    // A dirty tree is what makes git rewrite the index on a status refresh, so every worktree
    // — the main one included, since getWorktrees() returns it — has to be dirty for this to
    // reproduce. Verified: without GIT_OPTIONAL_LOCKS=0 the main git dir reports `index.lock`.
    await Bun.write(path.join(repo, "dirty.txt"), "main\n");

    // This is the fan-out that makes the feedback loop worst-case: one status per worktree,
    // behind an endpoint that is refetched on every refs_changed/log_changed broadcast.
    const worktrees = ["w1", "w2", "w3"].map((name) => path.join(base, name));
    for (const [i, wt] of worktrees.entries()) {
      await Bun.$`git -C ${repo} worktree add -q -b ${`br${i}`} ${wt}`.quiet();
      // Dirty each one: a clean tree gives git less reason to rewrite the index.
      await Bun.write(path.join(wt, "dirty.txt"), `${i}\n`);
    }

    const { log } = await startWatcher(repo);

    // Rewriting files in the working tree is invisible to the watcher (it only watches the git
    // dir) but forces git to refresh the index.
    await expectSilentRounds(repo, log, 6, async (round) => {
      for (const [i, wt] of [repo, ...worktrees].entries()) {
        await Bun.write(path.join(wt, "dirty.txt"), `round ${round} wt ${i}\n`);
      }
      const probes = await readWorktreeStatuses(repo);
      // main + w1..w3, all dirty.
      expect(probes.filter((probe) => probe.status).length).toBe(worktrees.length + 1);
    });
  }, 180000);

  test("working-tree diffs with untracked files produce no git-directory events", async () => {
    const base = scratchDir("untracked-diff-");
    // Real path: the diff validates the worktree against `git worktree list`, which resolves
    // macOS's /var → /private/var symlink.
    const repo = realpathSync(await seedRepo(path.join(base, "repo")));
    // The untracked half of the diff goes through `git add --intent-to-add`, which stores the
    // empty blob — or, when it already exists, freshens its mtime. Against the real object
    // store that is an `objects/` event, i.e. a status/refs/log refresh that refetches this
    // very diff. Seed the empty blob so the freshen path is the one exercised, with an old mtime
    // so that the freshen is a change whatever the file system's mtime granularity.
    const emptyBlob = (await Bun.$`git -C ${repo} hash-object -w -t blob /dev/null`.text()).trim();
    const blobPath = path.join(repo, ".git/objects", emptyBlob.slice(0, 2), emptyBlob.slice(2));
    utimesSync(blobPath, new Date(0), new Date(0));
    await Bun.write(path.join(repo, "new-a.txt"), "a\n");
    await Bun.write(path.join(repo, "new-b.txt"), "b\n");

    const { log } = await startWatcher(repo);

    await expectSilentRounds(repo, log, 1, async () => {
      const diff = await getWorkingTreeDiff(repo, repo);
      expect(diff.files.map((file) => file.newPath).sort()).toEqual(["new-a.txt", "new-b.txt"]);
    });
  }, 120000);

  test("bare repo: edits inside .worktrees/ produce no events", async () => {
    const base = scratchDir("bare-");
    const seed = await seedRepo(path.join(base, "seed"));
    const bare = path.join(base, "bare");
    await Bun.$`git clone -q --bare ${seed} ${bare}`.quiet();

    // The working tree lives INSIDE the recursively watched directory for a bare repo, which
    // is the whole reason classifyGitChange has to be start-anchored.
    const wt = path.join(bare, ".worktrees", "foo");
    await Bun.$`git -C ${bare} worktree add -q -b foo ${wt}`.quiet();
    expect(existsSync(path.join(wt, "a.txt"))).toBe(true);

    const { log } = await startWatcher(bare);

    mkdirSync(path.join(wt, "src"), { recursive: true });
    mkdirSync(path.join(wt, "node_modules", "p"), { recursive: true });
    await expectSilentRounds(bare, log, 1, async (round) => {
      await Bun.write(path.join(wt, "src", "a.ts"), `export const a = ${round};\n`);
      await Bun.write(path.join(wt, "node_modules", "p", "index.js"), `// ${round}\n`);
      await Bun.write(path.join(wt, "a.txt"), `edited by hand ${round}\n`);
    });
  }, 120000);

  // The native watch drops events during the flood, the ref write's included, and gives no signal
  // that it did. https://github.com/bizimind/loxel/issues/914
  test.todo("a ref written during a mass delete inside .worktrees/ is still reported", async () => {
    const base = scratchDir("bare-flood-");
    const seed = await seedRepo(path.join(base, "seed"));
    const bare = path.join(base, "bare");
    await Bun.$`git clone -q --bare ${seed} ${bare}`.quiet();
    const wt = path.join(bare, ".worktrees", "foo");
    await Bun.$`git -C ${bare} worktree add -q -b foo ${wt}`.quiet();
    const deps = path.join(wt, "node_modules");
    mkdirSync(deps);
    for (let i = 0; i < 20000; i++) writeFileSync(path.join(deps, `f${i}.js`), "x");

    const { log } = await startWatcher(bare);
    const since = await settled(bare, log);

    rmSync(deps, { recursive: true });
    await Bun.$`git -C ${bare} tag during-flood`.quiet();

    await log.waitFor((event) => event === "log", { since, label: "the tag's event" });
  }, 120000);

  test("bare repo: deleting a large tree inside .worktrees/ emits no worktrees event", async () => {
    const base = scratchDir("bare-mass-");
    const seed = await seedRepo(path.join(base, "seed"));
    const bare = path.join(base, "bare");
    await Bun.$`git clone -q --bare ${seed} ${bare}`.quiet();
    const wt = path.join(bare, ".worktrees", "foo");
    await Bun.$`git -C ${bare} worktree add -q -b foo ${wt}`.quiet();

    const deps = path.join(wt, "node_modules");
    mkdirSync(deps);
    for (let i = 0; i < 3000; i++) writeFileSync(path.join(deps, `f${i}.js`), "x");

    const { log } = await startWatcher(bare);
    const since = await settled(bare, log);

    // Bun cross-delivers a recursive watch's churn to the non-recursive `worktrees/` watch in
    // the same process, as changes to `worktrees` itself; the entry set has not changed.
    rmSync(deps, { recursive: true });

    // Repeated because the native watch can drop events during a flood, ours included. Not much
    // bigger than this: the loss reaches other processes, so it fails tests running in parallel.
    const flood = log.mark();
    await retryUntil(
      async (attempt) => {
        await Bun.$`git -C ${bare} tag ${`after-flood-${attempt}`}`.quiet();
      },
      (timeoutMs) => log.seenWithin((event) => event === "log", flood, timeoutMs),
      "an event after the flood",
    );
    expect(log.slice(since)).not.toContain("worktrees");
  }, 120000);
});
