import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WatchEvent } from "./file-watcher";
import { classifyGitChange, FileWatcher } from "./file-watcher";
import { getDirtyWorktreeStatuses, getStatus } from "./git-commands";
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
    "config",
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
 * Integration coverage for the `<commonDir>/worktrees` directory watch.
 *
 * These drive real `git worktree` commands against a real repo because the bug they guard
 * against lives entirely in what macOS FSEvents chooses to report — it is invisible to any
 * test that only calls classifyGitChange. Timings are generous: FSEvents latency stacks on
 * top of the watcher's debounce.
 */
describe("FileWatcher worktree lifecycle", () => {
  const SCRATCH = tmpdir();
  const DEBOUNCE_MS = 150;
  /** How long to wait for an event that should arrive (FSEvents latency + debounce). */
  const POLL_MS = 10000;
  /** How long to wait before concluding an event did NOT arrive. */
  const SETTLE_MS = 4000;
  /** FSEvents needs a moment to arm before it reports anything. */
  const ARM_MS = 800;

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

  function startWatcher(gitRoot: string) {
    const seen: WatchEvent[] = [];
    const watcher = new FileWatcher({
      gitRoot,
      debounceMs: DEBOUNCE_MS,
      onEvent: (event) => seen.push(event),
    });
    cleanups.push(() => watcher.stop());
    return { seen, watcher };
  }

  /** Poll until `worktrees` is seen, or give up. Returns whether it fired. */
  async function sawWorktrees(seen: WatchEvent[]) {
    const deadline = Date.now() + POLL_MS;
    while (Date.now() < deadline) {
      if (seen.includes("worktrees")) return true;
      await Bun.sleep(100);
    }
    return false;
  }

  test("fires on add and remove when worktrees/ already exists", async () => {
    const { base, repo } = await makeRepo();

    // Create and drop a throwaway worktree so `.git/worktrees` exists before start().
    const warmup = path.join(base, "warmup");
    await Bun.$`git -C ${repo} worktree add -q -b warmup ${warmup}`.quiet();
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(true);

    const { seen, watcher } = startWatcher(repo);
    await watcher.start();
    await Bun.sleep(ARM_MS);

    const added = path.join(base, "added");
    await Bun.$`git -C ${repo} worktree add -q -b added ${added}`.quiet();
    expect(await sawWorktrees(seen)).toBe(true);

    seen.length = 0;
    await Bun.$`git -C ${repo} worktree remove --force ${added}`.quiet();
    expect(await sawWorktrees(seen)).toBe(true);

    await Bun.$`git -C ${repo} worktree remove --force ${warmup}`.quiet();
  }, 60000);

  test("fires on the first-ever worktree, when worktrees/ is absent at start()", async () => {
    const { base, repo } = await makeRepo();
    expect(existsSync(path.join(repo, ".git", "worktrees"))).toBe(false);

    const { seen, watcher } = startWatcher(repo);
    await watcher.start();
    await Bun.sleep(ARM_MS);

    const first = path.join(base, "first");
    await Bun.$`git -C ${repo} worktree add -q -b first ${first}`.quiet();
    expect(await sawWorktrees(seen)).toBe(true);

    // The lazy attach should now be live, so removal is observed too.
    seen.length = 0;
    await Bun.$`git -C ${repo} worktree remove --force ${first}`.quiet();
    expect(await sawWorktrees(seen)).toBe(true);
  }, 60000);

  test("commits inside a worktree do not emit worktrees", async () => {
    const { base, repo } = await makeRepo();
    const wt = path.join(base, "noisy");
    await Bun.$`git -C ${repo} worktree add -q -b noisy ${wt}`.quiet();

    const { seen, watcher } = startWatcher(repo);
    await watcher.start();
    await Bun.sleep(ARM_MS);

    await Bun.write(path.join(wt, "a.txt"), "a");
    await Bun.$`git -C ${wt} add -A`.quiet();
    await Bun.$`git -C ${wt} -c user.email=t@t -c user.name=t commit -q -m noise`.quiet();
    await Bun.$`git -C ${wt} checkout -q -b other`.quiet();
    await Bun.sleep(SETTLE_MS);

    expect(seen).not.toContain("worktrees");

    // Prove the watcher was live for the duration, so the absence above is a real negative
    // and not a dead watcher: removing the same worktree must still be observed.
    await Bun.$`git -C ${repo} worktree remove --force ${wt}`.quiet();
    expect(await sawWorktrees(seen)).toBe(true);
  }, 60000);

  test("stop() closes delivery and start() restores it without duplicate watchers", async () => {
    const { base, repo } = await makeRepo();
    const wt = path.join(base, "w");
    await Bun.$`git -C ${repo} worktree add -q -b w ${wt}`.quiet();

    const { seen, watcher } = startWatcher(repo);
    await watcher.start();
    await watcher.start(); // second call must not double-watch
    await Bun.sleep(ARM_MS);
    watcher.stop();

    seen.length = 0;
    await Bun.$`git -C ${repo} worktree remove --force ${wt}`.quiet();
    await Bun.sleep(SETTLE_MS);
    expect(seen).toEqual([]);

    await watcher.start();
    await Bun.sleep(ARM_MS);
    const afterRestart = path.join(base, "after-restart");
    await Bun.$`git -C ${repo} worktree add -q -b after-restart ${afterRestart}`.quiet();
    expect(await sawWorktrees(seen)).toBe(true);
    await Bun.$`git -C ${repo} worktree remove --force ${afterRestart}`.quiet();
  }, 60000);
});

/**
 * End-to-end coverage for live status/refs/log updates.
 *
 * The bug these guard against was completely invisible to the unit suite above: every rule in
 * classifyGitChange was individually correct, but macOS FSEvents never reported the filenames
 * those rules matched. Only a real repo driving real git commands exercises the coalescing
 * behaviour, so these tests are slow by necessity — FSEvents latency stacks on the debounce.
 */
describe("FileWatcher live git updates", () => {
  const SCRATCH = tmpdir();
  const DEBOUNCE_MS = 100;
  /** How long to wait for an event that should arrive (FSEvents latency + debounce). */
  const POLL_MS = 15000;
  /** How long to wait before concluding no event arrived. */
  const SETTLE_MS = 5000;
  /** FSEvents needs a moment to arm before it reports anything. */
  const ARM_MS = 1000;

  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
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
    // The fsmonitor daemon getStatus starts writes into the git dir; leave none running.
    cleanups.push(async () => {
      await Bun.$`git -C ${repo} fsmonitor--daemon stop`.nothrow().quiet();
    });
    return repo;
  }

  async function startWatcher(gitRoot: string) {
    const seen: WatchEvent[] = [];
    const watcher = new FileWatcher({
      gitRoot,
      debounceMs: DEBOUNCE_MS,
      onEvent: (event) => seen.push(event),
    });
    cleanups.push(() => watcher.stop());
    await watcher.start();
    await Bun.sleep(ARM_MS);
    return { seen, watcher };
  }

  /** Poll until at least one event lands, or give up. */
  async function sawAny(seen: WatchEvent[]) {
    const deadline = Date.now() + POLL_MS;
    while (Date.now() < deadline) {
      if (seen.length > 0) return true;
      await Bun.sleep(100);
    }
    return false;
  }

  test("every common git operation produces at least one event", async () => {
    const base = scratchDir("live-");
    const repo = await seedRepo(path.join(base, "repo"));
    const { seen } = await startWatcher(repo);

    // One repo, run sequentially: each step asserts on a cleared buffer. Splitting these into
    // separate tests would multiply FSEvents arm time by six for no extra coverage.
    const steps: Array<[string, () => Promise<void>]> = [
      [
        "add",
        async () => {
          await Bun.write(path.join(repo, "b.txt"), "b\n");
          await Bun.sleep(SETTLE_MS / 4);
          seen.length = 0;
          await Bun.$`git -C ${repo} add b.txt`.quiet();
        },
      ],
      ["commit", async () => void (await Bun.$`git -C ${repo} commit -q -m second`.quiet())],
      ["branch", async () => void (await Bun.$`git -C ${repo} branch topic`.quiet())],
      ["checkout", async () => void (await Bun.$`git -C ${repo} checkout -q topic`.quiet())],
      ["tag", async () => void (await Bun.$`git -C ${repo} tag v9`.quiet())],
      [
        "stash",
        async () => {
          await Bun.write(path.join(repo, "a.txt"), "dirty\n");
          await Bun.sleep(SETTLE_MS / 4);
          seen.length = 0;
          await Bun.$`git -C ${repo} stash push -q`.quiet();
        },
      ],
      [
        "reset --hard",
        async () => {
          await Bun.write(path.join(repo, "a.txt"), "dirty again\n");
          await Bun.sleep(SETTLE_MS / 4);
          seen.length = 0;
          await Bun.$`git -C ${repo} reset -q --hard HEAD`.quiet();
        },
      ],
      ["branch -D", async () => void (await Bun.$`git -C ${repo} branch -D main`.quiet())],
    ];

    for (const [label, run] of steps) {
      seen.length = 0;
      await run();
      const fired = await sawAny(seen);
      expect(fired, `expected git ${label} to emit at least one event`).toBe(true);
    }
  }, 180000);

  test("repeated read-only getStatus calls produce no events", async () => {
    const base = scratchDir("ro-");
    const repo = await seedRepo(path.join(base, "repo"));

    // A dirty working tree is the case that used to loop: git rewrites the index on every
    // status refresh, so `index.lock` churned once per call.
    await Bun.write(path.join(repo, "dirty.txt"), "x\n");
    const { seen } = await startWatcher(repo);
    seen.length = 0;

    // Spaced rounds, re-dirtying between them: FSEvents coalesces bursts, so back-to-back
    // calls can hide the `index.lock` write this asserts the absence of.
    for (let round = 0; round < 6; round++) {
      await Bun.write(path.join(repo, "dirty.txt"), `round ${round}\n`);
      await getStatus(repo);
      await Bun.sleep(400);
    }
    await Bun.sleep(SETTLE_MS);

    expect(seen).toEqual([]);
  }, 120000);

  test("file-tree status refreshes produce no git-directory events", async () => {
    const base = scratchDir("file-tree-ro-");
    const repo = await seedRepo(path.join(base, "repo"));
    await Bun.write(path.join(repo, "dirty.txt"), "x\n");

    const { seen } = await startWatcher(repo);
    const filesService = new ProjectFilesService(repo, () => {});
    seen.length = 0;

    for (let round = 0; round < 6; round++) {
      await Bun.write(path.join(repo, "dirty.txt"), `round ${round}\n`);
      await filesService.refreshGitStatus();
      await Bun.sleep(400);
    }
    await Bun.sleep(SETTLE_MS);

    expect(seen).toEqual([]);
  }, 120000);

  test("getDirtyWorktreeStatuses over several worktrees produces no events", async () => {
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
      cleanups.push(async () => {
        await Bun.$`git -C ${wt} fsmonitor--daemon stop`.nothrow().quiet();
      });
      // Dirty each one: a clean tree gives git less reason to rewrite the index.
      await Bun.write(path.join(wt, "dirty.txt"), `${i}\n`);
    }

    const { seen } = await startWatcher(repo);
    seen.length = 0;

    // Several spaced rounds, re-dirtying between them. FSEvents coalesces a burst into a
    // nondeterministic subset of filenames, so a single round only reports the offending
    // `index.lock` most of the time — spacing the rounds out is what makes this a reliable
    // detector rather than a coin flip. Rewriting files in the working tree is invisible to
    // the watcher (it only watches the git dir) but forces git to refresh the index.
    for (let round = 0; round < 6; round++) {
      for (const [i, wt] of [repo, ...worktrees].entries()) {
        await Bun.write(path.join(wt, "dirty.txt"), `round ${round} wt ${i}\n`);
      }
      const statuses = await getDirtyWorktreeStatuses(repo);
      // main + w1..w3, all dirty.
      expect(statuses.length).toBe(worktrees.length + 1);
      await Bun.sleep(400);
    }
    await Bun.sleep(SETTLE_MS);

    expect(seen).toEqual([]);

    // Guard against a false negative from a dead watcher.
    await Bun.$`git -C ${repo} branch proof`.quiet();
    expect(await sawAny(seen)).toBe(true);
  }, 180000);

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

    const { seen } = await startWatcher(bare);
    seen.length = 0;

    mkdirSync(path.join(wt, "src"), { recursive: true });
    mkdirSync(path.join(wt, "node_modules", "p"), { recursive: true });
    await Bun.write(path.join(wt, "src", "a.ts"), "export const a = 1;\n");
    await Bun.write(path.join(wt, "node_modules", "p", "index.js"), "module.exports = {};\n");
    await Bun.write(path.join(wt, "a.txt"), "edited by hand\n");
    await Bun.sleep(SETTLE_MS);

    expect(seen).toEqual([]);

    // Prove the watcher was live for the duration, so the empty buffer above is a real
    // negative rather than a dead watch: a ref update in the bare repo must still fire.
    await Bun.$`git -C ${bare} branch proof`.quiet();
    expect(await sawAny(seen)).toBe(true);
  }, 120000);
});
