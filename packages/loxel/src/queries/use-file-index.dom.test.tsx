import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

const requested: string[] = [];
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  getFileIndex: async (wt: string) => {
    requested.push(wt);
    return { files: [`${wt}/index.ts`], truncated: false };
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

    // The other server's worktree is read for itself, not served this one's index.
    const other = renderHook(() => useFileIndexQuery(there), { wrapper });
    expect(other.result.current.data).toBeUndefined();
    await waitFor(() => expect(requested).toEqual(["/repo", "/repo"]));
  });

  test("asks for nothing without a worktree, or before its project is known", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    renderHook(() => useFileIndexQuery(null), { wrapper });
    renderHook(() => useFileIndexQuery(localRef("/repo")), { wrapper });

    expect(requested).toEqual([]);
  });
});
