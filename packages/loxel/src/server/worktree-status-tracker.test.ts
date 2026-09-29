import { describe, expect, test } from "bun:test";

import type { StatusInfo, WorktreeStatusInfo } from "@/api/git-models";

import type { WorktreeStatusProbe } from "./git-commands";
import { WorktreeStatusTracker } from "./worktree-status-tracker";

const MAIN = "/repo";
const OTHER = "/repo/.worktrees/other";

function status(untracked: string[] = []): StatusInfo {
  return {
    branch: "main",
    commit: "abc",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked,
    conflicted: [],
  };
}

function dirty(path: string, untracked: string[]): WorktreeStatusInfo {
  return {
    path,
    branch: "main",
    commit: "abc",
    isMain: path === MAIN,
    staged: [],
    unstaged: [],
    untracked,
  };
}

/** A controllable stand-in for `readWorktreeStatuses`. */
function fakeGit() {
  const state = new Map<string, WorktreeStatusInfo | null | undefined>([
    [MAIN, null],
    [OTHER, null],
  ]);
  let gate: Promise<void> | null = null;
  const fake = {
    state,
    sweeps: 0,
    /** Hold sweeps until the returned function is called. */
    hold() {
      let release = () => {};
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    readStatuses: async (
      _cwd: string,
      options: { liveStatus?: (path: string) => StatusInfo | undefined } = {},
    ): Promise<WorktreeStatusProbe[]> => {
      fake.sweeps++;
      const snapshot = [...state];
      if (gate) await gate;
      return snapshot.map(([path, value]) => {
        const live = options.liveStatus?.(path);
        const worktree = {
          path,
          branch: "main",
          commit: "abc",
          isMain: path === MAIN,
          createdAt: null,
        };
        return { worktree, status: live ? dirty(path, live.untracked) : value };
      });
    },
  };
  return fake;
}

function makeTracker(
  git: ReturnType<typeof fakeGit>,
  opts: { listeners?: boolean; live?: Map<string, StatusInfo>; requestMaxAgeMs?: number } = {},
) {
  const published: WorktreeStatusInfo[][] = [];
  const tracker = new WorktreeStatusTracker({
    projectPath: MAIN,
    liveStatus: (path) => opts.live?.get(path),
    hasListeners: () => opts.listeners ?? true,
    onChange: (statuses) => published.push(statuses),
    readStatuses: git.readStatuses,
    urgentDelayMs: 10,
    activityIntervalMs: 200,
    requestMaxAgeMs: opts.requestMaxAgeMs ?? 60_000,
  });
  return { tracker, published };
}

describe("WorktreeStatusTracker", () => {
  test("sweeps once and serves the cache until invalidated", async () => {
    const git = fakeGit();
    git.state.set(OTHER, dirty(OTHER, ["x"]));
    const { tracker } = makeTracker(git, { listeners: false });

    expect(await tracker.get()).toEqual([dirty(OTHER, ["x"])]);
    expect(await tracker.get()).toEqual([dirty(OTHER, ["x"])]);
    expect(git.sweeps).toBe(1);

    tracker.invalidate();
    git.state.set(OTHER, null);
    expect(await tracker.get()).toEqual([]);
    expect(git.sweeps).toBe(2);
  });

  test("a request re-reads once the last sweep is older than the max age", async () => {
    const git = fakeGit();
    const { tracker } = makeTracker(git, { listeners: false, requestMaxAgeMs: 50 });
    await tracker.get();
    await tracker.get();
    expect(git.sweeps).toBe(1);

    // An unwatched worktree changed without any event the tracker could see.
    git.state.set(OTHER, dirty(OTHER, ["agent-edit"]));
    await Bun.sleep(80);
    expect(await tracker.get()).toEqual([dirty(OTHER, ["agent-edit"])]);
    expect(git.sweeps).toBe(2);
  });

  test("concurrent requests share one sweep", async () => {
    const git = fakeGit();
    const { tracker } = makeTracker(git, { listeners: false });
    await Promise.all([tracker.get(), tracker.get(), tracker.get()]);
    expect(git.sweeps).toBe(1);
  });

  test("an invalidation during a sweep queues exactly one follow-up", async () => {
    const git = fakeGit();
    const { tracker } = makeTracker(git, { listeners: false });
    const release = git.hold();
    const first = tracker.get();
    await Bun.sleep(5);

    // Commits land while the sweep is reading: its answer is already stale.
    tracker.invalidate();
    git.state.set(OTHER, dirty(OTHER, ["late"]));
    const second = tracker.get();
    const third = tracker.get();
    release();

    await first;
    expect(await second).toEqual([dirty(OTHER, ["late"])]);
    expect(await third).toEqual([dirty(OTHER, ["late"])]);
    expect(git.sweeps).toBe(2);
  });

  test("an invalidation sweeps in the background and publishes the change", async () => {
    const git = fakeGit();
    const { tracker, published } = makeTracker(git);
    await tracker.get();
    git.state.set(OTHER, dirty(OTHER, ["x"]));

    tracker.invalidate();
    tracker.invalidate();
    await Bun.sleep(60);

    expect(git.sweeps).toBe(2);
    expect(published.at(-1)).toEqual([dirty(OTHER, ["x"])]);
  });

  test("a live update publishes at once and rate-limits the follow-up sweep", async () => {
    const git = fakeGit();
    const { tracker, published } = makeTracker(git);
    await tracker.get();
    expect(git.sweeps).toBe(1);

    for (let i = 0; i < 10; i++) tracker.update(MAIN, status([`f${i}`]));

    expect(published.at(-1)).toEqual([dirty(MAIN, ["f9"])]);
    expect(git.sweeps).toBe(1);
    await Bun.sleep(100);
    expect(git.sweeps).toBe(1); // still inside the activity interval
    await Bun.sleep(200);
    expect(git.sweeps).toBe(2); // one sweep for the whole burst
  });

  test("activity sweeps are spaced from the end of a slow sweep", async () => {
    const git = fakeGit();
    const { tracker } = makeTracker(git);
    await tracker.get();

    // A sweep slower than the activity interval.
    const release = git.hold();
    tracker.invalidate();
    await Bun.sleep(20);
    expect(git.sweeps).toBe(2);
    await Bun.sleep(300);
    release();
    await Bun.sleep(5);

    tracker.update(MAIN, status(["edit"]));
    await Bun.sleep(100);
    expect(git.sweeps).toBe(2); // not immediately after the slow sweep finished
    await Bun.sleep(200);
    expect(git.sweeps).toBe(3);
  });

  test("a sweep does not undo a newer live status", async () => {
    const git = fakeGit();
    const live = new Map<string, StatusInfo>();
    const { tracker } = makeTracker(git, { listeners: false, live });
    await tracker.get();

    const release = git.hold();
    tracker.invalidate();
    const pending = tracker.get();
    await Bun.sleep(5);
    live.set(MAIN, status(["newest"]));
    release();

    expect(await pending).toEqual([dirty(MAIN, ["newest"])]);
  });

  test("an unreadable status keeps its last value; a clean one clears it", async () => {
    const git = fakeGit();
    git.state.set(OTHER, dirty(OTHER, ["x"]));
    const { tracker } = makeTracker(git, { listeners: false });
    await tracker.get();

    git.state.set(OTHER, undefined);
    tracker.invalidate();
    expect(await tracker.get()).toEqual([dirty(OTHER, ["x"])]);

    git.state.set(OTHER, null);
    tracker.invalidate();
    expect(await tracker.get()).toEqual([]);
  });

  test("an update for an unknown worktree sweeps; once a list exists, only rate-limited", async () => {
    const git = fakeGit();
    const { tracker } = makeTracker(git);
    tracker.update(OTHER, status(["x"]));
    await Bun.sleep(60);
    expect(git.sweeps).toBe(1);

    // A path that never matches the list (e.g. reached through a symlink).
    for (let i = 0; i < 5; i++) tracker.update("/elsewhere", status(["y"]));
    await Bun.sleep(60);
    expect(git.sweeps).toBe(1);
    await Bun.sleep(250);
    expect(git.sweeps).toBe(2);
  });

  test("publishes only when the list changes", async () => {
    const git = fakeGit();
    const { tracker, published } = makeTracker(git, { listeners: false });
    await tracker.get();
    tracker.invalidate();
    await tracker.get();
    expect(published).toHaveLength(1);
  });

  test("nothing sweeps in the background without listeners, or after dispose", async () => {
    const git = fakeGit();
    const quiet = makeTracker(git, { listeners: false });
    quiet.tracker.invalidate();
    await Bun.sleep(40);
    expect(git.sweeps).toBe(0);

    const disposed = makeTracker(git);
    disposed.tracker.invalidate();
    disposed.tracker.dispose();
    await Bun.sleep(40);
    expect(git.sweeps).toBe(0);
  });
});
