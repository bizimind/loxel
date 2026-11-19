import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { wsClient } from "@/api/client";
import { localServerId, localRef } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";
import type { WsClientMessage } from "@/api/ws-protocol";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { fileEditorKey, useEditorStateStore } from "@/store/editor-state";
import { activeWorktreeFields, useWorktreeStore } from "@/store/worktrees";

import { useWsSubscription } from "./useWsSubscription";

const WT = "/repo/.worktrees/wt";
const EXTERNAL = "/elsewhere/notes.md";
const WT_REF = localRef(WT);

const sent: WsClientMessage[] = [];

beforeAll(() => {
  spyOn(wsClient, "subscribeWorktree").mockImplementation(() => {});
  spyOn(wsClient, "send").mockImplementation((message) => {
    sent.push(message);
  });
  useWorktreeStore.setState(activeWorktreeFields(WT_REF));
  const server = localServerId();
  for (const path of [EXTERNAL, `${WT}/src/a.ts`]) {
    useEditorStateStore.getState().openFile(fileEditorKey(server, path), server, path);
  }
  renderHook(() => useWsSubscription(WT_REF));
});

afterAll(() => {
  cleanup();
  useEditorStateStore.setState({ files: new Map() });
});

describe("useWsSubscription", () => {
  test("registers open files outside the worktree once the server has resynced it", () => {
    dispatchLoxelEvent("loxel-worktree-files-resynced", { wt: localRef("/repo/.worktrees/other") });
    // The same path on another server is another worktree.
    dispatchLoxelEvent("loxel-worktree-files-resynced", {
      wt: worktreeRef(toServerId("other-server"), WT),
    });
    expect(sent).toEqual([]);

    dispatchLoxelEvent("loxel-worktree-files-resynced", { wt: WT_REF });

    expect(sent).toEqual([
      { type: "register_external_files", worktreePath: WT, filePaths: [EXTERNAL] },
    ]);
  });

  test("subscribes nothing for a worktree of a server it has no connection to, and does not throw", () => {
    const subscribe = spyOn(wsClient, "subscribeWorktree").mockImplementation(() => {});
    subscribe.mockClear();
    const stale = worktreeRef(toServerId("old-server-id"), WT);
    const { rerender } = renderHook(({ wt }) => useWsSubscription(wt), {
      initialProps: { wt: stale as typeof WT_REF | null },
    });
    // The project list then moves the window to a worktree of its own server.
    rerender({ wt: WT_REF });

    expect(subscribe.mock.calls).toEqual([[WT_REF]]);
  });
});
