import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { localServerId } from "@/api/local-server";
import { type ServerId, toServerId } from "@/api/worktree-ref";

// The file never loads, so what an editor starts from is what the cache holds for it.
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getFileContentByPath: () => new Promise(() => {}),
}));

const { LayoutServerContext, PanelWorktreeProvider } =
  await import("@/components/dockview/panel-context");
const { fileEditorKey } = await import("@/store/editor-state");
const { useDiskSyncedContent } = await import("./use-disk-synced-content");

const WT = "/repo";
const FILE = `${WT}/notes.md`;
const OTHER = toServerId("other-server");

afterEach(cleanup);

function inLayout(server: ServerId) {
  const client = new QueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <LayoutServerContext.Provider value={server}>
        <PanelWorktreeProvider worktreePath={WT}>{children}</PanelWorktreeProvider>
      </LayoutServerContext.Provider>
    </QueryClientProvider>
  );
}

describe("useDiskSyncedContent", () => {
  test("caches content by the file's server, so the same path on another server starts apart", () => {
    const here = fileEditorKey(localServerId(), FILE);
    const cache = new Map([[here, "cached here"]]);
    const options = { filePath: FILE, deserialize: (raw: string) => raw, contentCache: cache };

    const mine = renderHook(() => useDiskSyncedContent(options), {
      wrapper: inLayout(localServerId()),
    });
    const theirs = renderHook(() => useDiskSyncedContent(options), { wrapper: inLayout(OTHER) });

    expect(mine.result.current.cacheKey).toBe(here);
    expect(mine.result.current.diskContent).toBe("cached here");
    expect(theirs.result.current.cacheKey).toBe(fileEditorKey(OTHER, FILE));
    expect(theirs.result.current.diskContent).toBeNull();

    // Closing the other server's editor drops only its own entry.
    theirs.unmount();
    expect(cache.get(here)).toBe("cached here");
  });
});
