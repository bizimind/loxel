import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { wsClient } from "@/api/client";
import type { WsClientMessage } from "@/api/ws-protocol";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { useEditorStateStore } from "@/store/editor-state";
import { useWorktreeStore } from "@/store/worktrees";

import { useWsSubscription } from "./useWsSubscription";

const WT = "/repo/.worktrees/wt";
const EXTERNAL = "/elsewhere/notes.md";

const sent: WsClientMessage[] = [];

beforeAll(() => {
  spyOn(wsClient, "subscribeWorktree").mockImplementation(() => {});
  spyOn(wsClient, "send").mockImplementation((message) => {
    sent.push(message);
  });
  useWorktreeStore.setState({ activeWorktreePath: WT });
  useEditorStateStore.getState().openFile(EXTERNAL);
  useEditorStateStore.getState().openFile(`${WT}/src/a.ts`);
  renderHook(() => useWsSubscription(WT));
});

afterAll(() => {
  cleanup();
  useEditorStateStore.setState({ files: new Map() });
});

describe("useWsSubscription", () => {
  test("registers open files outside the worktree once the server has resynced it", () => {
    dispatchLoxelEvent("loxel-worktree-files-resynced", { wtPath: "/repo/.worktrees/other" });
    expect(sent).toEqual([]);

    dispatchLoxelEvent("loxel-worktree-files-resynced", { wtPath: WT });

    expect(sent).toEqual([
      { type: "register_external_files", worktreePath: WT, filePaths: [EXTERNAL] },
    ]);
  });
});
