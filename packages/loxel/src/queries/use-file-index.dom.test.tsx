import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";

const requested: WorktreeRef[] = [];
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  getFileIndex: async (wt: WorktreeRef) => {
    requested.push(wt);
    return { files: [`${wt.path}/index.ts`], truncated: false };
  },
}));

const { useProjectStore } = await import("@/store/projects");
const { queryKeys } = await import("./query-keys");
const { useFileIndexQuery } = await import("./use-file-index");

const THERE = toServerId("other-server");

function project(server: typeof THERE) {
  return { id: server, server, path: "/repo", name: "repo", isBare: false, worktrees: [] };
}

afterEach(() => {
  requested.length = 0;
  useProjectStore.setState({ projects: [] });
});

describe("useFileIndexQuery", () => {
  test("caches each worktree's index under its ref, so the same path elsewhere is apart", async () => {
    useProjectStore.setState({ projects: [project(localServerId()), project(THERE)] as never });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const here = localRef("/repo");

    const { result } = renderHook(() => useFileIndexQuery(here), { wrapper });
    await waitFor(() => expect(result.current.data?.files).toEqual(["/repo/index.ts"]));

    const there = worktreeRef(THERE, "/repo");
    expect(client.getQueryData(queryKeys.fileIndex(here, here))).toBeDefined();
    expect(client.getQueryData(queryKeys.fileIndex(there, there))).toBeUndefined();

    // The other server's worktree is never served this one's index, nor asked of this server.
    const other = renderHook(() => useFileIndexQuery(there), { wrapper });
    expect(other.result.current.data).toBeUndefined();
    expect(other.result.current.fetchStatus).toBe("idle");
    expect(requested).toEqual([localRef("/repo")]);
  });

  test("asks for nothing without a worktree, or before its project is known", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const home = renderHook(() => useFileIndexQuery(null), { wrapper });
    const unlisted = renderHook(() => useFileIndexQuery(localRef("/repo")), { wrapper });

    expect(home.result.current.fetchStatus).toBe("idle");
    expect(unlisted.result.current.fetchStatus).toBe("idle");
    expect(requested).toEqual([]);
  });

  test("is read again for a fresh reader, and taken from the cache by the others", async () => {
    useProjectStore.setState({ projects: [project(localServerId())] as never });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const here = localRef("/repo");
    const first = renderHook(() => useFileIndexQuery(here), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    const cached = renderHook(() => useFileIndexQuery(here), { wrapper });
    expect(cached.result.current.fetchStatus).toBe("idle");
    expect(requested).toEqual([localRef("/repo")]);

    renderHook(() => useFileIndexQuery(here, { fresh: true }), { wrapper });
    await waitFor(() => expect(requested).toEqual([localRef("/repo"), localRef("/repo")]));
  });
});
