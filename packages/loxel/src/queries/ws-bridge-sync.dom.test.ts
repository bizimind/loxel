/**
 * Which queries each git and worktree message refreshes: the renderer's half of keeping the changes
 * panel, the project explorer, the commit graph and the sidebar in sync with the server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

import type { Query } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { wsClient } from "@/api/client";
import type { StatusInfo, WorktreeStatusInfo } from "@/api/git-models";
import { localRef, localServerId } from "@/api/local-server";
import type { DirEntry } from "@/api/project-files-model";
import { toServerId, worktreeRef } from "@/api/worktree-ref";
import type { WsMessage } from "@/api/ws-protocol";
import { onLoxelEvent } from "@/lib/loxel-events";
import { queryClient } from "@/query-client";
import { type ListedProject, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

import { queryKeys } from "./query-keys";
import { useWsBridge } from "./ws-bridge";

const PROJECT_PATH = "/repo";
const WT_PATH = "/repo/.worktrees/wt";
const PROJECT = localRef(PROJECT_PATH);
const WT = localRef(WT_PATH);
/** The same paths on another server, which no message of this one's may touch. */
const ELSEWHERE = toServerId("other-server");
const PROJECT_ELSEWHERE = worktreeRef(ELSEWHERE, PROJECT_PATH);

const setQueryData = spyOn(queryClient, "setQueryData");
const invalidateQueries = spyOn(queryClient, "invalidateQueries");
const refreshProjectWorktrees = mock(async () => {});
const fetchProjects = mock(async () => {});
let deliver: (message: WsMessage) => void = () => {};
let reconnect: () => void = () => {};
// The stores are shared with other test files in the process; put their actions back after.
const originalFetchProjects = useProjectStore.getState().fetchProjects;
const originalRefreshProjectWorktrees = useWorktreeStore.getState().refreshProjectWorktrees;

beforeAll(() => {
  spyOn(wsClient, "connect").mockImplementation(() => {});
  spyOn(wsClient, "disconnect").mockImplementation(() => {});
  spyOn(wsClient, "subscribe").mockImplementation((handler) => {
    deliver = handler;
    return () => {};
  });
  spyOn(wsClient, "onReconnect").mockImplementation((handler) => {
    reconnect = handler;
    return () => {};
  });
  useProjectStore.setState({
    projects: [{ server: localServerId(), path: PROJECT_PATH } as ListedProject],
    fetchProjects,
  });
  useWorktreeStore.setState({ refreshProjectWorktrees });
  renderHook(() => useWsBridge());
});

afterEach(() => {
  setQueryData.mockClear();
  invalidateQueries.mockClear();
  refreshProjectWorktrees.mockClear();
  fetchProjects.mockClear();
});

afterAll(() => {
  cleanup();
  useProjectStore.setState({ fetchProjects: originalFetchProjects });
  useWorktreeStore.setState({ refreshProjectWorktrees: originalRefreshProjectWorktrees });
});

/** The exact-key invalidations a message made. */
const invalidatedKeys = () =>
  invalidateQueries.mock.calls.flatMap(([filters]) =>
    filters?.queryKey ? [filters.queryKey] : [],
  );

/** Which of these query keys the message's predicate invalidations match. */
function matchedByPredicates(keys: ReadonlyArray<readonly unknown[]>) {
  return keys.filter((queryKey) =>
    invalidateQueries.mock.calls.some(([filters]) => filters?.predicate?.({ queryKey } as Query)),
  );
}

const STAGED_DIFF = queryKeys.diff(PROJECT, { type: "staged", worktree: WT_PATH });
const UNSTAGED_DIFF = queryKeys.diff(PROJECT, { type: "unstaged", worktree: WT_PATH });
const UNCOMMITTED_DIFF = queryKeys.diff(PROJECT, { type: "uncommitted", worktree: WT_PATH });
const COMMIT_DIFF = queryKeys.diff(PROJECT, { type: "commit", commit: "abc" });
const OTHER_PROJECT_DIFF = queryKeys.diff(localRef("/other"), {
  type: "staged",
  worktree: WT_PATH,
});
const OTHER_SERVER_DIFF = queryKeys.diff(PROJECT_ELSEWHERE, { type: "staged", worktree: WT_PATH });
const DIFF_KEYS = [
  STAGED_DIFF,
  UNSTAGED_DIFF,
  UNCOMMITTED_DIFF,
  COMMIT_DIFF,
  OTHER_PROJECT_DIFF,
  OTHER_SERVER_DIFF,
];
const WORKING_TREE_DIFFS = [STAGED_DIFF, UNSTAGED_DIFF, UNCOMMITTED_DIFF];

describe("useWsBridge git messages", () => {
  test.each([
    { message: { type: "refs_changed", projectPath: PROJECT_PATH, data: [] }, branches: true },
    { message: { type: "log_changed", projectPath: PROJECT_PATH }, branches: false },
  ] satisfies { message: WsMessage; branches: boolean }[])(
    "$message.type refetches the commit lists and working-tree diffs (and branches on a ref change), and nothing else",
    ({ message, branches }) => {
      deliver(message);

      expect(invalidatedKeys()).toEqual([
        queryKeys.projectCommits(PROJECT),
        queryKeys.projectBranchCommits(PROJECT),
        ...(branches ? [queryKeys.branches(PROJECT)] : []),
      ]);
      expect(matchedByPredicates(DIFF_KEYS)).toEqual(WORKING_TREE_DIFFS);
      expect(setQueryData).not.toHaveBeenCalled();
    },
  );

  test("status_changed writes the status and refetches only working-tree diffs", () => {
    const data = { branch: "main" } as StatusInfo;

    deliver({ type: "status_changed", wtPath: WT_PATH, data });

    expect(setQueryData.mock.calls).toEqual([[queryKeys.status(PROJECT, WT), data]]);
    expect(invalidatedKeys()).toEqual([]);
    expect(matchedByPredicates(DIFF_KEYS)).toEqual(WORKING_TREE_DIFFS);
  });

  test("worktree_status_changed writes the list without refetching anything", () => {
    const data = [{ path: WT_PATH }] as WorktreeStatusInfo[];

    deliver({ type: "worktree_status_changed", projectPath: PROJECT_PATH, data });

    expect(setQueryData.mock.calls).toEqual([[queryKeys.worktreeStatuses(PROJECT), data]]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  test("worktrees_changed refreshes that project's worktree list", () => {
    deliver({ type: "worktrees_changed", data: { projectPath: PROJECT_PATH } });

    expect(refreshProjectWorktrees.mock.calls).toEqual([[localRef(PROJECT_PATH)] as never]);
    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("useWsBridge after a reconnect", () => {
  test("refetches everything but file contents, and the projects", async () => {
    reconnect();

    const keys = [
      queryKeys.status(PROJECT, WT),
      queryKeys.projectCommits(PROJECT),
      COMMIT_DIFF,
      queryKeys.runningTerminals(localServerId()),
      queryKeys.fileContent(PROJECT, "a.ts", undefined, WT),
    ];
    // Editors with unsaved changes take new content through worktree_files_resynced instead.
    expect(matchedByPredicates(keys)).toEqual(keys.slice(0, -1));
    expect(fetchProjects).toHaveBeenCalledTimes(1);
    // Worktrees removed meanwhile are released by the per-project refresh.
    await waitFor(() =>
      expect(refreshProjectWorktrees).toHaveBeenCalledWith(localRef(PROJECT_PATH)),
    );
  });
});

describe("useWsBridge file messages", () => {
  test("worktree_files_resynced refetches what the paused watchers may have missed", () => {
    deliver({ type: "worktree_files_resynced", wtPath: WT_PATH, projectPath: PROJECT_PATH });

    expect(invalidatedKeys()).toEqual([
      queryKeys.status(PROJECT, WT),
      queryKeys.worktreeStatuses(PROJECT),
      queryKeys.detachedFiles(PROJECT, WT),
      queryKeys.externalFiles(PROJECT, WT),
    ]);
    // Only this worktree's working-tree diffs and directory listings.
    const otherWtDiff = queryKeys.diff(PROJECT, { type: "staged", worktree: `${WT_PATH}2` });
    const ownDirs = [
      queryKeys.dirContents(PROJECT, WT_PATH),
      queryKeys.dirContents(PROJECT, `${WT_PATH}/src`),
    ];
    const otherDirs = [
      queryKeys.dirContents(PROJECT, `${WT_PATH}2`),
      queryKeys.dirContents(localRef("/other"), WT_PATH),
      queryKeys.dirContents(PROJECT_ELSEWHERE, WT_PATH),
    ];
    expect(matchedByPredicates([...DIFF_KEYS, otherWtDiff, ...ownDirs, ...otherDirs])).toEqual([
      ...WORKING_TREE_DIFFS,
      ...ownDirs,
    ]);
    expect(setQueryData).not.toHaveBeenCalled();
  });

  test("worktree_files_resynced refetches this worktree's files as on disk, on its server only", () => {
    deliver({ type: "worktree_files_resynced", wtPath: WT_PATH, projectPath: PROJECT_PATH });

    const own = queryKeys.fileContent(PROJECT, "a.ts", undefined, WT);
    const others = [
      queryKeys.fileContent(PROJECT, "a.ts", "HEAD", WT),
      queryKeys.fileContent(PROJECT, "a.ts", undefined, localRef(`${WT_PATH}2`)),
      queryKeys.fileContent(PROJECT_ELSEWHERE, "a.ts", undefined, worktreeRef(ELSEWHERE, WT_PATH)),
    ];
    expect(matchedByPredicates([own, ...others])).toEqual([own]);
  });

  test("worktree_files_resynced tells the files tree once its listings are invalidated", () => {
    const ownDir = queryKeys.dirContents(PROJECT, `${WT_PATH}/src`);
    const seen: Array<{ wtPath: string; dirInvalidated: boolean }> = [];
    const unsubscribe = onLoxelEvent("loxel-worktree-files-resynced", ({ wtPath }) => {
      seen.push({ wtPath, dirInvalidated: matchedByPredicates([ownDir]).length === 1 });
    });

    deliver({ type: "worktree_files_resynced", wtPath: WT_PATH, projectPath: PROJECT_PATH });
    unsubscribe();

    expect(seen).toEqual([{ wtPath: WT_PATH, dirInvalidated: true }]);
  });

  test("files_dir_changed writes that directory's listing", () => {
    const entries = [{ name: "a.txt" }] as DirEntry[];

    deliver({ type: "files_dir_changed", wtPath: WT_PATH, data: { dir: WT_PATH, entries } });

    expect(setQueryData.mock.calls).toEqual([[queryKeys.dirContents(PROJECT, WT_PATH), entries]]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  test("file_content_changed refetches the diff view's working-tree side of the file", () => {
    deliver({
      type: "file_content_changed",
      wtPath: WT_PATH,
      data: { path: `${WT_PATH}/a.txt`, nonces: [] },
    });

    expect(invalidatedKeys()).toEqual([queryKeys.fileContent(PROJECT, "a.txt", undefined, WT)]);
  });
});
