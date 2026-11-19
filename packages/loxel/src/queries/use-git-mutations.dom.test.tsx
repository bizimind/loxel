import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";

const reverted: WorktreeRef[] = [];
const committed: WorktreeRef[] = [];
let commitGate = Promise.resolve();
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  createCommit: async (wt: WorktreeRef) => {
    committed.push(wt);
    await commitGate;
    return { success: true };
  },
  revertToHead: async (wt: WorktreeRef) => {
    reverted.push(wt);
    return { success: true };
  },
}));

const { useProjectStore } = await import("@/store/projects");
const { activeWorktreeFields, useWorktreeStore } = await import("@/store/worktrees");
const { queryKeys } = await import("./query-keys");
const { useCreateCommitMutation, useRevertToHeadMutation } = await import("./use-git-mutations");

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

    expect(reverted).toEqual([here]);
    expect(client.getQueryState(ownStatus)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherStatus)?.isInvalidated).toBe(false);
  });
});

describe("a mutation of the active worktree", () => {
  test("refreshes the worktree it started in when the window switches meanwhile", async () => {
    useProjectStore.setState({ projects: [project(localServerId()), project(THERE)] as never });
    const here = localRef("/repo");
    const there = worktreeRef(THERE, "/repo");
    useWorktreeStore.setState(activeWorktreeFields(here));
    const client = new QueryClient();
    const ownStatus = queryKeys.status(here, here);
    const otherStatus = queryKeys.status(there, there);
    client.setQueryData(ownStatus, {});
    client.setQueryData(otherStatus, {});
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const gate = Promise.withResolvers<void>();
    commitGate = gate.promise;
    const { result, rerender } = renderHook(() => useCreateCommitMutation(), { wrapper });

    let committing: Promise<unknown> = Promise.resolve();
    act(() => {
      committing = result.current.mutateAsync("message");
    });
    // The same path on another server is shown before the commit is answered.
    act(() => useWorktreeStore.setState(activeWorktreeFields(there)));
    rerender();
    await act(async () => {
      gate.resolve();
      await committing;
    });

    expect(committed).toEqual([here]);
    expect(client.getQueryState(ownStatus)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherStatus)?.isInvalidated).toBe(false);
  });
});
