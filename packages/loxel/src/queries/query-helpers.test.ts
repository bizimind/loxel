import { afterEach, describe, expect, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";
import { queryClient } from "@/query-client";
import { useProjectStore } from "@/store/projects";
import { activeWorktreeFields, useWorktreeStore } from "@/store/worktrees";

import { invalidateDirQueries, removeDirQueries } from "./query-helpers";
import { queryKeys } from "./query-keys";

const THERE = toServerId("other-server");
const here = localRef("/repo");
const there = worktreeRef(THERE, "/repo");

function project(server: typeof THERE) {
  return { id: server, server, path: "/repo", name: "repo", isBare: false, worktrees: [] };
}

afterEach(() => {
  queryClient.clear();
  useProjectStore.setState({ projects: [] });
  useWorktreeStore.setState(activeWorktreeFields(null));
});

describe("directory listing refreshes", () => {
  test("go to the worktree the operation ran in, not the same path on the server shown now", () => {
    useProjectStore.setState({ projects: [project(localServerId()), project(THERE)] as never });
    // The operation ran in `here`; the window has since switched to `there`.
    useWorktreeStore.setState(activeWorktreeFields(there));
    const ownKey = queryKeys.dirContents(here, "/repo/src");
    const otherKey = queryKeys.dirContents(there, "/repo/src");
    queryClient.setQueryData(ownKey, []);
    queryClient.setQueryData(otherKey, []);

    invalidateDirQueries(here, "src");

    expect(queryClient.getQueryState(ownKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);

    removeDirQueries(queryClient, here, "/repo");
    expect(queryClient.getQueryData(ownKey)).toBeUndefined();
    expect(queryClient.getQueryData(otherKey)).toEqual([]);
  });
});
