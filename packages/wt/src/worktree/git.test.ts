import { describe, test, expect } from "bun:test";

import { parseWorktreeList, findWorktreeByName, type Worktree } from "./git.ts";

describe("parseWorktreeList", () => {
  test("empty output returns empty array", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  test("whitespace only returns empty array", () => {
    expect(parseWorktreeList("   \n   \n   ")).toEqual([]);
  });

  test("single worktree", () => {
    const output = `worktree /path/to/repo
HEAD abc123def
branch refs/heads/main
`;
    const result = parseWorktreeList(output);
    expect(result).toEqual([
      { path: "/path/to/repo", head: "abc123def", branch: "main", bare: false },
    ]);
  });

  test("multiple worktrees", () => {
    const output = `worktree /repo
HEAD aaa111
branch refs/heads/main

worktree /repo/.worktrees/feature
HEAD bbb222
branch refs/heads/feature

worktree /repo/.worktrees/bugfix
HEAD ccc333
branch refs/heads/bugfix
`;
    const result = parseWorktreeList(output);
    expect(result).toHaveLength(3);
    expect(result[0]!.path).toBe("/repo");
    expect(result[0]!.branch).toBe("main");
    expect(result[1]!.path).toBe("/repo/.worktrees/feature");
    expect(result[1]!.branch).toBe("feature");
    expect(result[2]!.path).toBe("/repo/.worktrees/bugfix");
    expect(result[2]!.branch).toBe("bugfix");
  });

  test("bare repo entry", () => {
    const output = `worktree /repo.git
HEAD abc123
bare
`;
    const result = parseWorktreeList(output);
    expect(result).toEqual([{ path: "/repo.git", head: "abc123", branch: null, bare: true }]);
  });

  test("detached HEAD", () => {
    const output = `worktree /repo
HEAD abc123
detached
`;
    const result = parseWorktreeList(output);
    expect(result).toEqual([{ path: "/repo", head: "abc123", branch: null, bare: false }]);
  });

  test("strips refs/heads/ from branch", () => {
    const output = `worktree /repo
HEAD abc123
branch refs/heads/feature/nested/branch
`;
    const result = parseWorktreeList(output);
    expect(result[0]!.branch).toBe("feature/nested/branch");
  });

  test("mixed bare and non-bare worktrees", () => {
    const output = `worktree /repo.git
HEAD aaa111
bare

worktree /repo.git/.worktrees/feature
HEAD bbb222
branch refs/heads/feature

worktree /repo.git/.worktrees/detached
HEAD ccc333
detached
`;
    const result = parseWorktreeList(output);

    expect(result).toHaveLength(3);

    expect(result[0]!.bare).toBe(true);
    expect(result[0]!.branch).toBeNull();

    expect(result[1]!.bare).toBe(false);
    expect(result[1]!.branch).toBe("feature");

    expect(result[2]!.bare).toBe(false);
    expect(result[2]!.branch).toBeNull();
  });

  test("handles extra blank lines", () => {
    const output = `

worktree /repo
HEAD abc123
branch refs/heads/main


worktree /repo/.worktrees/test
HEAD def456
branch refs/heads/test

`;
    const result = parseWorktreeList(output);
    expect(result).toHaveLength(2);
  });
});

describe("findWorktreeByName", () => {
  const worktrees: Worktree[] = [
    { path: "/repo.git", head: "aaa", branch: null, bare: true },
    { path: "/repo.git/.worktrees/feature-auth", head: "bbb", branch: "feature-auth", bare: false },
    { path: "/repo.git/.worktrees/bugfix-123", head: "ccc", branch: "bugfix-123", bare: false },
  ];

  test("finds worktree by name", () => {
    const result = findWorktreeByName(worktrees, "feature-auth");
    expect(result).toBeDefined();
    expect(result?.path).toBe("/repo.git/.worktrees/feature-auth");
    expect(result?.branch).toBe("feature-auth");
  });

  test("finds another worktree by name", () => {
    const result = findWorktreeByName(worktrees, "bugfix-123");
    expect(result).toBeDefined();
    expect(result?.path).toBe("/repo.git/.worktrees/bugfix-123");
  });

  test("returns undefined when not found", () => {
    const result = findWorktreeByName(worktrees, "nonexistent");
    expect(result).toBeUndefined();
  });

  test("matches on last path component only", () => {
    const result = findWorktreeByName(worktrees, ".worktrees");
    expect(result).toBeUndefined();
  });

  test("empty array returns undefined", () => {
    const result = findWorktreeByName([], "anything");
    expect(result).toBeUndefined();
  });

  test("can find bare repo by name", () => {
    const result = findWorktreeByName(worktrees, "repo.git");
    expect(result).toBeDefined();
    expect(result?.bare).toBe(true);
  });

  test("disambiguates suffix matches with worktreesDir", () => {
    const wts: Worktree[] = [
      { path: "/repo.git", head: "aaa", branch: null, bare: true },
      { path: "/repo.git/.worktrees/review", head: "bbb", branch: "review", bare: false },
      { path: "/repo.git/.worktrees/feat/review", head: "ccc", branch: "feat/review", bare: false },
    ];
    const worktreesDir = "/repo.git/.worktrees";

    const review = findWorktreeByName(wts, "review", worktreesDir);
    expect(review?.path).toBe("/repo.git/.worktrees/review");

    const featReview = findWorktreeByName(wts, "feat/review", worktreesDir);
    expect(featReview?.path).toBe("/repo.git/.worktrees/feat/review");
  });
});
