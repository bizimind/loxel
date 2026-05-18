import { describe, expect, test } from "bun:test";

import type { WatchEvent } from "./file-watcher";
import { classifyGitChange } from "./file-watcher";

describe("classifyGitChange", () => {
  test.each([
    { file: "index.lock", expected: [] as WatchEvent[] },
    { file: "refs/heads/main.lock", expected: [] as WatchEvent[] },
    { file: "HEAD.lock", expected: [] as WatchEvent[] },
  ])("ignores lock file: $file", ({ file, expected }) => {
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

  test("worktree non-gitdir file emits nothing", () => {
    expect(classifyGitChange("worktrees/my-worktree/HEAD")).not.toContain("worktrees");
  });

  test("unknown file emits nothing", () => {
    expect(classifyGitChange("objects/pack/pack-abc.idx")).toEqual([]);
  });
});
