import { describe, expect, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

import {
  isDirContentsKeyBelow,
  isEditorConfigKeyBelow,
  isKeyWithinWorktree,
  isWorkingTreeDiffKey,
  keyServer,
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
    expect(parts(queryKeys.version(localServerId()))).toEqual([
      "version",
      { server: localServerId() },
    ]);
    expect(parts(queryKeys.pathExists(ELSEWHERE, "/a"))).toEqual([
      "pathExists",
      { server: ELSEWHERE },
      "/a",
    ]);
  });

  test("keeps Home's keys without a server", () => {
    expect(parts(queryKeys.fileContent(null, "/drafts/a.md"))).toEqual([
      "fileContent",
      null,
      "/drafts/a.md",
      undefined,
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

describe("keyServer", () => {
  test("is the server of a key's ref or server part, and null for Home's", () => {
    expect(keyServer(queryKeys.status(null, WT))).toBe(localServerId());
    expect(
      keyServer(queryKeys.editorConfig(ELSEWHERE, "/a.ts", worktreeRef(ELSEWHERE, "/x"))),
    ).toBe(ELSEWHERE);
    expect(keyServer(queryKeys.repoTrustList(ELSEWHERE))).toBe(ELSEWHERE);
    expect(keyServer(queryKeys.pathExists(ELSEWHERE, "/a"))).toBe(ELSEWHERE);
    expect(keyServer(queryKeys.fileContent(null, "/drafts/a.md"))).toBeNull();
    expect(keyServer(queryKeys.diff(null, { type: "staged", worktree: "/x" }))).toBeNull();
  });
});

describe("isEditorConfigKeyBelow", () => {
  test("matches only the given server's keys under the directory", () => {
    const here = queryKeys.editorConfig(localServerId(), "/repo/src/a.ts");
    const there = queryKeys.editorConfig(ELSEWHERE, "/repo/src/a.ts");
    expect(isEditorConfigKeyBelow(here, localServerId(), "/repo/")).toBe(true);
    expect(isEditorConfigKeyBelow(there, localServerId(), "/repo/")).toBe(false);
    expect(isEditorConfigKeyBelow(there, ELSEWHERE, "")).toBe(true);
    expect(isEditorConfigKeyBelow(here, localServerId(), "/other/")).toBe(false);
  });
});

describe("isKeyWithinWorktree", () => {
  const HOME = localServerId();

  test("matches keys of the worktree's server naming it or a path in it", () => {
    expect(isKeyWithinWorktree(queryKeys.status(PROJECT, WT), WT, HOME)).toBe(true);
    expect(isKeyWithinWorktree(queryKeys.dirContents(PROJECT, `${WT.path}/src`), WT, HOME)).toBe(
      true,
    );
    expect(isKeyWithinWorktree(queryKeys.pathExists(HOME, `${WT.path}/a`), WT, HOME)).toBe(true);
    const diff = (worktree: string) => queryKeys.diff(PROJECT, { type: "uncommitted", worktree });
    expect(isKeyWithinWorktree(diff(WT.path), WT, HOME)).toBe(true);
    expect(isKeyWithinWorktree(diff(`${WT.path}2`), WT, HOME)).toBe(false);
    const sibling = localRef(`${WT.path}2`);
    expect(isKeyWithinWorktree(queryKeys.status(PROJECT, sibling), WT, HOME)).toBe(false);
  });

  test("leaves another server's keys under the same path alone", () => {
    const project = worktreeRef(ELSEWHERE, PROJECT.path);
    const wt = worktreeRef(ELSEWHERE, WT.path);
    const keys = [
      queryKeys.status(project, wt),
      queryKeys.dirContents(project, `${WT.path}/src`),
      queryKeys.fileContent(project, `${WT.path}/a.ts`),
      queryKeys.fileContent(project, "a.ts", undefined, wt),
      queryKeys.editorConfig(ELSEWHERE, `${WT.path}/a.ts`, wt),
      queryKeys.pathExists(ELSEWHERE, `${WT.path}/a`),
      queryKeys.diff(project, { type: "uncommitted", worktree: WT.path }),
    ];
    for (const key of keys) expect(isKeyWithinWorktree(key, WT, HOME)).toBe(false);
    // And the other way: releasing the other server's worktree leaves this one's.
    expect(isKeyWithinWorktree(queryKeys.status(PROJECT, WT), wt, HOME)).toBe(false);
  });

  test("counts a key naming no server as the window's own server's", () => {
    const homeKey = queryKeys.fileContent(null, `${WT.path}/a.ts`);
    expect(isKeyWithinWorktree(homeKey, WT, HOME)).toBe(true);
    expect(isKeyWithinWorktree(homeKey, worktreeRef(ELSEWHERE, WT.path), HOME)).toBe(false);
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
