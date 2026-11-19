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
});
