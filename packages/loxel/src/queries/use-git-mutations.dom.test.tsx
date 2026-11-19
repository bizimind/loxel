import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

const reverted: string[] = [];
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  revertToHead: async (wt: string) => {
    reverted.push(wt);
    return { success: true };
  },
}));

const { useProjectStore } = await import("@/store/projects");
const { activeWorktreeFields, useWorktreeStore } = await import("@/store/worktrees");
const { queryKeys } = await import("./query-keys");
const { useRevertToHeadMutation } = await import("./use-git-mutations");

const THERE = toServerId("other-server");

function project(server: typeof THERE) {
  return { id: server, server, path: "/repo", name: "repo", isBare: false, worktrees: [] };
}

afterEach(() => {
  useProjectStore.setState({ projects: [] });
  useWorktreeStore.setState(activeWorktreeFields(null));
});

describe("useRevertToHeadMutation", () => {
  test("refreshes its own worktree's status, not the same path's on the server shown", async () => {
    useProjectStore.setState({ projects: [project(localServerId()), project(THERE)] as never });
    const there = worktreeRef(THERE, "/repo");
    useWorktreeStore.setState(activeWorktreeFields(there));
    const client = new QueryClient();
    const here = localRef("/repo");
    const ownStatus = queryKeys.status(here, here);
    const otherStatus = queryKeys.status(there, there);
    client.setQueryData(ownStatus, {});
    client.setQueryData(otherStatus, {});
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRevertToHeadMutation(), { wrapper });

    await act(() => result.current.mutateAsync({ worktree: here, files: ["a.ts"] }));

    expect(reverted).toEqual(["/repo"]);
    expect(client.getQueryState(ownStatus)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherStatus)?.isInvalidated).toBe(false);
  });
});
