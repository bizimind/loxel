import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { ReactNode } from "react";

import { localRef } from "@/api/local-server";
import type { ServerNotification } from "@/api/notification-model";
import { type ServerId, toServerId } from "@/api/worktree-ref";
import { layoutKeyOf } from "@/store/active-worktree";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { setCenterApi } from "@/store/tools-bar";

import { LayoutServerContext } from "./panel-context";
import { usePanelNotificationDot } from "./use-panel-notification-dot";

const PATH = "/repo";
/** Another server, holding the same path. */
const THERE = toServerId("other-server");
const PANEL_ID = "terminal-1";

/** An inactive tab's api: a dot shows only on a tab not on screen. */
const api = { id: PANEL_ID, isActive: false, onDidActiveChange: () => ({ dispose() {} }) };
const tab = { api: api as unknown as DockviewPanelApi };

function inLayout(server: ServerId) {
  return ({ children }: { children: ReactNode }) => (
    <LayoutServerContext.Provider value={server}>{children}</LayoutServerContext.Provider>
  );
}

function notification(): ServerNotification {
  return {
    id: "n1",
    timestamp: 0,
    source: { kind: "terminal", panelId: PANEL_ID, worktreePath: PATH },
    urgency: "normal",
  };
}

afterEach(() => {
  cleanup();
  setCenterApi(null);
  usePanelNotificationStore.setState({ notifications: [], panelIndex: new Set() });
});

describe("a tab's notification dot", () => {
  test("is its layout's server's panel's, whatever layout the center shows", () => {
    // The window's center shows the same path on the window's server.
    setCenterApi({} as DockviewApi, layoutKeyOf(localRef(PATH)));
    usePanelNotificationStore.getState().syncAll(THERE, [notification()]);

    const { result } = renderHook(() => usePanelNotificationDot(tab, PANEL_ID), {
      wrapper: inLayout(THERE),
    });

    expect(result.current).toBe(true);
  });
});
