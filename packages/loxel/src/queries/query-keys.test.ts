import { describe, expect, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

import {
  isDirContentsKeyBelow,
  isKeyWithinWorktree,
  isWorkingTreeDiffKey,
  queryKeys,
  workingTreeFileContentKey,
} from "./query-keys";

const PROJECT = localRef("/repo");
const WT = localRef("/repo/.worktrees/a");
const ELSEWHERE = toServerId("other-server");

/** A key's parts as a plain array, to compare with a literal or a prefix. */
const parts = (key: readonly unknown[]): unknown[] => [...key];

describe("queryKeys", () => {
  test("names the server of every project and worktree it keys", () => {
    expect(parts(queryKeys.status(PROJECT, WT))).toEqual([
      "status",
      { server: localServerId(), path: "/repo" },
      { server: localServerId(), path: "/repo/.worktrees/a" },
    ]);
  });

  test("tells the same path on two servers apart", () => {
    const here = queryKeys.branches(PROJECT);
    const there = queryKeys.branches(worktreeRef(ELSEWHERE, "/repo"));
    expect(here).not.toEqual(there);
  });

  test("names the server of server-wide data", () => {
    expect(parts(queryKeys.version(localServerId()))).toEqual(["version", localServerId()]);
    expect(parts(queryKeys.pathExists(ELSEWHERE, "/a"))).toEqual(["pathExists", ELSEWHERE, "/a"]);
  });

  test("keeps Home's keys without a server", () => {
    expect(parts(queryKeys.editorConfig("/drafts/a.md"))).toEqual([
      "editorConfig",
      "/drafts/a.md",
      undefined,
    ]);
  });

  test("builds prefix keys that lead the keys they reach", () => {
    expect(parts(queryKeys.commits(PROJECT, WT, "all")).slice(0, 2)).toEqual(
      parts(queryKeys.projectCommits(PROJECT)),
    );
    expect(parts(queryKeys.toolchainFileStatus("c", PROJECT, WT, "/a.c")).slice(0, 4)).toEqual(
      parts(queryKeys.toolchainStatus("c", PROJECT, WT)),
    );
    const adapterKey = queryKeys.localdb(PROJECT);
    expect(parts(queryKeys.localdbRowsPage(adapterKey, "t", {})).slice(0, 4)).toEqual(
      parts(queryKeys.localdbRows(adapterKey, "t")),
    );
    expect(parts(queryKeys.localdbRows(adapterKey, "t")).slice(0, 2)).toEqual(parts(adapterKey));
  });
});

describe("isWorkingTreeDiffKey", () => {
  const staged = queryKeys.diff(PROJECT, { type: "staged", worktree: WT.path });

  test("matches a working-tree diff of the project, of the worktree when given", () => {
    expect(isWorkingTreeDiffKey(staged, PROJECT)).toBe(true);
    expect(isWorkingTreeDiffKey(staged, PROJECT, WT)).toBe(true);
    expect(isWorkingTreeDiffKey(staged, PROJECT, localRef("/repo/.worktrees/b"))).toBe(false);
    expect(isWorkingTreeDiffKey(queryKeys.diff(PROJECT, { type: "commit" }), PROJECT)).toBe(false);
  });

  test("does not match the same project path on another server", () => {
    expect(isWorkingTreeDiffKey(staged, worktreeRef(ELSEWHERE, "/repo"))).toBe(false);
  });
});

describe("isDirContentsKeyBelow", () => {
  test("matches the directory and those below it, in the project on its server", () => {
    const below = queryKeys.dirContents(PROJECT, `${WT.path}/src`);
    expect(isDirContentsKeyBelow(below, PROJECT, WT.path)).toBe(true);
    expect(isDirContentsKeyBelow(below, PROJECT, `${WT.path}2`)).toBe(false);
    expect(isDirContentsKeyBelow(below, worktreeRef(ELSEWHERE, "/repo"), WT.path)).toBe(false);
  });
});

describe("isKeyWithinWorktree", () => {
  test("matches keys naming the worktree or a path in it, on its server", () => {
    expect(isKeyWithinWorktree(queryKeys.status(PROJECT, WT), WT)).toBe(true);
    expect(isKeyWithinWorktree(queryKeys.dirContents(null, `${WT.path}/src`), WT)).toBe(true);
    expect(isKeyWithinWorktree(queryKeys.status(PROJECT, localRef(`${WT.path}2`)), WT)).toBe(false);
    const elsewhere = worktreeRef(ELSEWHERE, WT.path);
    expect(isKeyWithinWorktree(queryKeys.status(null, elsewhere), WT)).toBe(false);
  });
});

describe("workingTreeFileContentKey", () => {
  test("maps an absolute worktree path to the diff view's relative content key", () => {
    expect(workingTreeFileContentKey(PROJECT, WT, "/repo/.worktrees/a/src/x.ts")).toEqual(
      queryKeys.fileContent(PROJECT, "src/x.ts", undefined, WT),
    );
  });

  test("accepts a worktree path with a trailing slash", () => {
    const root = localRef("/repo/");
    expect(workingTreeFileContentKey(PROJECT, root, "/repo/test.txt")).toEqual(
      queryKeys.fileContent(PROJECT, "test.txt", undefined, root),
    );
  });

  test("returns null for paths outside the worktree", () => {
    expect(workingTreeFileContentKey(PROJECT, PROJECT, "/repo-other/test.txt")).toBeNull();
    expect(workingTreeFileContentKey(PROJECT, PROJECT, "/home/u/.local/state/draft.md")).toBeNull();
    expect(workingTreeFileContentKey(PROJECT, PROJECT, "/repo")).toBeNull();
    expect(workingTreeFileContentKey(PROJECT, PROJECT, "/repo/")).toBeNull();
  });
});
