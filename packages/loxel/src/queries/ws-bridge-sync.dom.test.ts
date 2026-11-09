/**
 * Which queries each git and worktree message refreshes: the renderer's half of keeping the changes
 * panel, the project explorer, the commit graph and the sidebar in sync with the server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

import type { Query } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";

import { wsClient } from "@/api/client";
import type { StatusInfo, WorktreeStatusInfo } from "@/api/git-models";
import type { DirEntry } from "@/api/project-files-model";
import type { EnrichedProject } from "@/api/project-model";
import type { WsMessage } from "@/api/ws-protocol";
import { queryClient } from "@/query-client";
import { useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

import { queryKeys } from "./query-keys";
import { useWsBridge } from "./ws-bridge";

const PROJECT = "/repo";
const WT = "/repo/.worktrees/wt";

const setQueryData = spyOn(queryClient, "setQueryData");
const invalidateQueries = spyOn(queryClient, "invalidateQueries");
const refreshProjectWorktrees = mock(async () => {});
let deliver: (message: WsMessage) => void = () => {};

beforeAll(() => {
  spyOn(wsClient, "connect").mockImplementation(() => {});
  spyOn(wsClient, "disconnect").mockImplementation(() => {});
  spyOn(wsClient, "subscribe").mockImplementation((handler) => {
    deliver = handler;
    return () => {};
  });
  useProjectStore.setState({ projects: [{ path: PROJECT } as EnrichedProject] });
  useWorktreeStore.setState({ refreshProjectWorktrees });
  renderHook(() => useWsBridge());
});

afterEach(() => {
  setQueryData.mockClear();
  invalidateQueries.mockClear();
  refreshProjectWorktrees.mockClear();
});

afterAll(() => {
  cleanup();
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

const STAGED_DIFF = queryKeys.diff(PROJECT, { type: "staged", worktree: WT });
const UNSTAGED_DIFF = queryKeys.diff(PROJECT, { type: "unstaged", worktree: WT });
const UNCOMMITTED_DIFF = queryKeys.diff(PROJECT, { type: "uncommitted", worktree: WT });
const COMMIT_DIFF = queryKeys.diff(PROJECT, { type: "commit", commit: "abc" });
const OTHER_PROJECT_DIFF = queryKeys.diff("/other", { type: "staged", worktree: WT });
const DIFF_KEYS = [STAGED_DIFF, UNSTAGED_DIFF, UNCOMMITTED_DIFF, COMMIT_DIFF, OTHER_PROJECT_DIFF];
const WORKING_TREE_DIFFS = [STAGED_DIFF, UNSTAGED_DIFF, UNCOMMITTED_DIFF];

describe("useWsBridge git messages", () => {
  test.each([
    { type: "refs_changed", projectPath: PROJECT, data: [] },
    { type: "log_changed", projectPath: PROJECT },
  ] satisfies WsMessage[])(
    "$type refetches the commit lists and working-tree diffs, and nothing else",
    (message) => {
      deliver(message);

      expect(invalidatedKeys()).toEqual([
        ["commits", PROJECT],
        ["branchCommits", PROJECT],
      ]);
      expect(matchedByPredicates(DIFF_KEYS)).toEqual(WORKING_TREE_DIFFS);
      expect(setQueryData).not.toHaveBeenCalled();
    },
  );

  test("status_changed writes the status and refetches only working-tree diffs", () => {
    const data = { branch: "main" } as StatusInfo;

    deliver({ type: "status_changed", wtPath: WT, data });

    expect(setQueryData.mock.calls).toEqual([[queryKeys.status(PROJECT, WT), data]]);
    expect(invalidatedKeys()).toEqual([]);
    expect(matchedByPredicates(DIFF_KEYS)).toEqual(WORKING_TREE_DIFFS);
  });

  test("worktree_status_changed writes the list without refetching anything", () => {
    const data = [{ path: WT }] as WorktreeStatusInfo[];

    deliver({ type: "worktree_status_changed", projectPath: PROJECT, data });

    expect(setQueryData.mock.calls).toEqual([[queryKeys.worktreeStatuses(PROJECT), data]]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  test("worktrees_changed refreshes that project's worktree list", () => {
    deliver({ type: "worktrees_changed", data: { projectPath: PROJECT } });

    expect(refreshProjectWorktrees.mock.calls).toEqual([[PROJECT] as never]);
    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("useWsBridge file messages", () => {
  test("worktree_files_resynced refetches what the paused watchers may have missed", () => {
    deliver({ type: "worktree_files_resynced", wtPath: WT, projectPath: PROJECT });

    expect(invalidatedKeys()).toEqual([
      queryKeys.status(PROJECT, WT),
      queryKeys.worktreeStatuses(PROJECT),
      ["diff", PROJECT],
      ["dirContents", PROJECT],
      queryKeys.detachedFiles(PROJECT, WT),
      queryKeys.externalFiles(PROJECT, WT),
    ]);
    expect(setQueryData).not.toHaveBeenCalled();
  });

  test("files_dir_changed writes that directory's listing", () => {
    const entries = [{ name: "a.txt" }] as DirEntry[];

    deliver({ type: "files_dir_changed", wtPath: WT, data: { dir: WT, entries } });

    expect(setQueryData.mock.calls).toEqual([[queryKeys.dirContents(PROJECT, WT), entries]]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  test("file_content_changed refetches the diff view's working-tree side of the file", () => {
    deliver({
      type: "file_content_changed",
      wtPath: WT,
      data: { path: `${WT}/a.txt`, nonces: [] },
    });

    expect(invalidatedKeys()).toEqual([queryKeys.fileContent(PROJECT, "a.txt", undefined, WT)]);
  });
});
