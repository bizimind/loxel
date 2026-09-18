import { describe, expect, test } from "bun:test";

import type { BranchCommits, CommitInfo } from "@/api/git-models";

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

const ccc = commitOf("ccc", "bbb");
const bbb = commitOf("bbb", "aaa");
// `old-main` predates everything this branch merged in, so diffing from it
// re-reports the default branch's own changes.
const aaa = commitOf("aaa", "old-main");
const MERGE_BASE = "merge-base-sha";

/** Newest first, as the branch-commits endpoint returns them. */
const branch: BranchCommits = { commits: [ccc, bbb, aaa], mergeBase: MERGE_BASE, truncated: false };

describe("resolveDiffBase", () => {
  test("the whole branch uses the merge base", () => {
    expect(resolveDiffBase({ oldest: aaa, newest: ccc }, branch)).toBe(MERGE_BASE);
  });

  test("a selection from the bottom up to the working tree uses the merge base", () => {
    // The working tree sits on the tip, so the merge base is an ancestor of it.
    expect(resolveDiffBase({ oldest: aaa, newest: null }, branch)).toBe(MERGE_BASE);
  });

  test("a selection from the bottom that stops short of the tip uses the parent", () => {
    // The merge base need not be an ancestor of `bbb`; a two-dot diff from it
    // would show the default branch's changes as deletions.
    expect(resolveDiffBase({ oldest: aaa, newest: bbb }, branch)).toBe("old-main");
    expect(resolveDiffBase({ oldest: aaa, newest: aaa }, branch)).toBe("old-main");
  });

  test("a sub-range above the bottom uses the parent of its oldest commit", () => {
    expect(resolveDiffBase({ oldest: bbb, newest: ccc }, branch)).toBe("aaa");
    expect(resolveDiffBase({ oldest: ccc, newest: ccc }, branch)).toBe("bbb");
    expect(resolveDiffBase({ oldest: bbb, newest: null }, branch)).toBe("aaa");
  });

  test("a full selection of a truncated list uses the parent", () => {
    // The listed bottom is only the oldest commit the endpoint returned.
    const truncated: BranchCommits = { ...branch, truncated: true };
    expect(resolveDiffBase({ oldest: aaa, newest: ccc }, truncated)).toBe("old-main");
    expect(resolveDiffBase({ oldest: aaa, newest: null }, truncated)).toBe("old-main");
  });

  test("falls back to the parent when there is no merge base", () => {
    // Detached HEAD, or a repository with no recognizable default branch.
    const noBase: BranchCommits = { ...branch, mergeBase: null };
    expect(resolveDiffBase({ oldest: aaa, newest: ccc }, noBase)).toBe("old-main");
  });

  test("falls back to the parent when the branch is not loaded", () => {
    expect(resolveDiffBase({ oldest: aaa, newest: ccc }, undefined)).toBe("old-main");
  });

  test("a root commit with no parent yields no base", () => {
    expect(resolveDiffBase({ oldest: commitOf("aaa"), newest: null }, undefined)).toBeUndefined();
  });

  test("a commit outside the branch range is treated as a sub-range", () => {
    // Graph selections can reach commits the branch dropdown never listed.
    expect(resolveDiffBase({ oldest: commitOf("zzz", "yyy"), newest: ccc }, branch)).toBe("yyy");
  });
});
