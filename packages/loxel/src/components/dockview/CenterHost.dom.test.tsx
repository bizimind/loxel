import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";

import { type ServerId, toServerId, worktreeRef } from "@/api/worktree-ref";
import type { WsClientMessage } from "@/api/ws-protocol";

/** Another server, holding the same paths as the window's. */
const THERE = toServerId("other-server");
const WORKTREE = worktreeRef(THERE, "/repo");

/** What each server's connection was sent. */
const sent: Array<{ server: ServerId; message: WsClientMessage }> = [];
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getStore: async () => null,
  putStore: async () => {},
  wsClientOf: (server: ServerId) => ({
    send: (message: WsClientMessage) => sent.push({ server, message }),
  }),
}));

// Panels that render nothing: only their removal is under test.
function Blank(_props: IDockviewPanelProps) {
  return null;
}
mock.module("./panels", () => ({
  centerComponents: { terminal: Blank, codeeditor: Blank },
  centerTabComponents: {},
  homeComponents: {},
  homeTabComponents: {},
}));

const { CenterHostComponent } = await import("./CenterHost");
const { getCenterApi } = await import("@/store/tools-bar");
const { activeWorktreeFields, useWorktreeStore } = await import("@/store/worktrees");

afterEach(() => {
  cleanup();
  sent.length = 0;
  useWorktreeStore.setState(activeWorktreeFields(null));
});

describe("closing a center panel", () => {
  test("tells the server of its layout, not the window's", async () => {
    useWorktreeStore.setState(activeWorktreeFields(WORKTREE));
    render(<CenterHostComponent {...({} as IDockviewPanelProps)} />);
    await waitFor(() => expect(getCenterApi()).not.toBeNull());
    const center = getCenterApi()!;

    act(() => {
      center.addPanel({ id: "terminal-1", component: "terminal", params: { terminalId: "t1" } });
      center.addPanel({
        id: "codeeditor-/elsewhere/a.ts",
        component: "codeeditor",
        params: { filePath: "/elsewhere/a.ts" },
      });
    });
    act(() => {
      for (const panel of [...center.panels]) center.removePanel(panel);
    });

    const closes = sent.filter(({ message }) =>
      ["terminal_destroy", "close_external_file"].includes(message.type),
    );
    expect(closes).toEqual([
      { server: THERE, message: { type: "terminal_destroy", id: "t1" } },
      {
        server: THERE,
        message: {
          type: "close_external_file",
          worktreePath: "/repo",
          filePath: "/elsewhere/a.ts",
        },
      },
    ]);
  });
});
