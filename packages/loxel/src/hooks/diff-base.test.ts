import { describe, expect, test } from "bun:test";

import type { CommitInfo } from "@/api/git-models";

import { resolveDiffBase } from "./diff-base";

function commitOf(hash: string, parent?: string): CommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: parent ? [parent] : [],
    message: hash,
    author: "t",
    authorEmail: "t@t",
    authorDate: "2026-01-01T00:00:00Z",
    committer: "t",
    committerEmail: "t@t",
    committerDate: "2026-01-01T00:00:00Z",
    refs: [],
  };
}

/** Newest first, as the branch-commits endpoint returns them. */
const branchCommits = [commitOf("ccc", "bbb"), commitOf("bbb", "aaa"), commitOf("aaa", "old-main")];
const MERGE_BASE = "merge-base-sha";

describe("resolveDiffBase", () => {
  test("a selection reaching the bottom of the branch uses the merge base", () => {
    // `old-main` predates everything this branch merged in, so diffing from it
    // re-reports the default branch's own changes.
    expect(resolveDiffBase(commitOf("aaa", "old-main"), branchCommits, MERGE_BASE)).toBe(
      MERGE_BASE,
    );
  });

  test("a sub-range uses the parent of its oldest commit", () => {
    expect(resolveDiffBase(commitOf("bbb", "aaa"), branchCommits, MERGE_BASE)).toBe("aaa");
    expect(resolveDiffBase(commitOf("ccc", "bbb"), branchCommits, MERGE_BASE)).toBe("bbb");
  });

  test("falls back to the parent when there is no merge base", () => {
    // Detached HEAD, or a repository with no recognizable default branch.
    expect(resolveDiffBase(commitOf("aaa", "old-main"), branchCommits, null)).toBe("old-main");
    expect(resolveDiffBase(commitOf("aaa", "old-main"), branchCommits, undefined)).toBe("old-main");
  });

  test("falls back to the parent when the branch range is unknown", () => {
    expect(resolveDiffBase(commitOf("aaa", "old-main"), [], MERGE_BASE)).toBe("old-main");
  });

  test("a root commit with no parent yields no base", () => {
    expect(resolveDiffBase(commitOf("aaa"), [], null)).toBeUndefined();
  });

  test("a commit outside the branch range is treated as a sub-range", () => {
    // Graph selections can reach commits the branch dropdown never listed.
    expect(resolveDiffBase(commitOf("zzz", "yyy"), branchCommits, MERGE_BASE)).toBe("yyy");
  });
});
