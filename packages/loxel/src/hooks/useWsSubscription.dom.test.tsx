import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { wsClient } from "@/api/client";
import type { WsClientMessage, WsMessage } from "@/api/ws-protocol";
import { useEditorStateStore } from "@/store/editor-state";
import { useWorktreeStore } from "@/store/worktrees";

import { useWsSubscription } from "./useWsSubscription";

const WT = "/repo/.worktrees/wt";
const EXTERNAL = "/elsewhere/notes.md";

const sent: WsClientMessage[] = [];
let deliver: (message: WsMessage) => void = () => {};

beforeAll(() => {
  spyOn(wsClient, "subscribeWorktree").mockImplementation(() => {});
  spyOn(wsClient, "send").mockImplementation((message) => {
    sent.push(message);
  });
  spyOn(wsClient, "subscribe").mockImplementation((handler) => {
    deliver = handler;
    return () => {};
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
    deliver({
      type: "worktree_files_resynced",
      wtPath: "/repo/.worktrees/other",
      projectPath: "/repo",
    });
    expect(sent).toEqual([]);

    deliver({ type: "worktree_files_resynced", wtPath: WT, projectPath: "/repo" });

    expect(sent).toEqual([
      { type: "register_external_files", worktreePath: WT, filePaths: [EXTERNAL] },
    ]);
  });
});
