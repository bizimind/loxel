import { describe, expect, test } from "bun:test";

import { queryKeys, workingTreeFileContentKey } from "./query-keys";

describe("workingTreeFileContentKey", () => {
  test("maps an absolute worktree path to the diff view's relative content key", () => {
    expect(
      workingTreeFileContentKey("/repo", "/repo/.worktrees/a", "/repo/.worktrees/a/src/x.ts"),
    ).toEqual(queryKeys.fileContent("/repo", "src/x.ts", undefined, "/repo/.worktrees/a"));
  });

  test("accepts a worktree path with a trailing slash", () => {
    expect(workingTreeFileContentKey("/repo", "/repo/", "/repo/test.txt")).toEqual(
      queryKeys.fileContent("/repo", "test.txt", undefined, "/repo/"),
    );
  });

  test("returns null for paths outside the worktree", () => {
    expect(workingTreeFileContentKey("/repo", "/repo", "/repo-other/test.txt")).toBeNull();
    expect(workingTreeFileContentKey("/repo", "/repo", "/home/u/.local/state/draft.md")).toBeNull();
    expect(workingTreeFileContentKey("/repo", "/repo", "/repo")).toBeNull();
    expect(workingTreeFileContentKey("/repo", "/repo", "/repo/")).toBeNull();
  });
});
