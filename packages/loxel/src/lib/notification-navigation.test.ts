import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { DockviewApi } from "dockview-react";

import { localRef, localServerId } from "@/api/local-server";
import type { NotificationSource } from "@/api/notification-model";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import { layoutKeyOf } from "@/store/active-worktree";
import type { ClientNotification } from "@/store/panel-notifications";
import { setCenterApi } from "@/store/tools-bar";
import { activeWorktreeFields, useWorktreeStore } from "@/store/worktrees";

const ELSEWHERE = toServerId("elsewhere");
/** The servers the window has a connection to, besides its own. */
let connected = new Set<string>();
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  hasConnection: (server: string) => server === localServerId() || connected.has(server),
}));

const { navigateToNotification } = await import("./notification-navigation");

const switchWorktree = mock(async (wt: WorktreeRef) => {
  useWorktreeStore.setState(activeWorktreeFields(wt));
});
const showHome = mock(() => useWorktreeStore.setState(activeWorktreeFields(null)));
const originals = useWorktreeStore.getState();

function notification(source: NotificationSource, server = localServerId()): ClientNotification {
  return { id: "n1", timestamp: 0, source, urgency: "normal", server };
}

const terminalIn = (worktreePath: string | null) =>
  ({ kind: "terminal", panelId: "terminal-1", worktreePath }) as const;

beforeEach(() => {
  useWorktreeStore.setState({
    ...activeWorktreeFields(localRef("/repo")),
    switchWorktree,
    showHome,
  });
});

afterEach(() => {
  connected = new Set();
  switchWorktree.mockClear();
  showHome.mockClear();
  setCenterApi(null);
  useWorktreeStore.setState({
    ...activeWorktreeFields(null),
    switchWorktree: originals.switchWorktree,
    showHome: originals.showHome,
  });
});

describe("navigateToNotification", () => {
  test("switches to the panel's worktree on the server that sent it", () => {
    navigateToNotification(notification(terminalIn("/repo/.worktrees/a")));

    expect(switchWorktree.mock.calls).toEqual([[localRef("/repo/.worktrees/a")]]);
  });

  test("stays put for the active worktree", () => {
    navigateToNotification(notification(terminalIn("/repo")));

    expect(switchWorktree).not.toHaveBeenCalled();
  });

  test("switches to the same path on another server", () => {
    connected.add(ELSEWHERE);
    navigateToNotification(notification(terminalIn("/repo"), ELSEWHERE));

    expect(switchWorktree.mock.calls).toEqual([[worktreeRef(ELSEWHERE, "/repo")]]);
  });

  test("stays put for a worktree of a server the window has no connection to", () => {
    navigateToNotification(notification(terminalIn("/repo/.worktrees/a"), ELSEWHERE));

    expect(switchWorktree).not.toHaveBeenCalled();
    expect(useWorktreeStore.getState().activeWorktree).toEqual(localRef("/repo"));
  });

  test("shows Home for a Home panel's notification", () => {
    navigateToNotification(notification(terminalIn(null)));

    expect(showHome).toHaveBeenCalledTimes(1);
    expect(switchWorktree).not.toHaveBeenCalled();
  });

  test("goes where an inbox notification's panels opened", () => {
    navigateToNotification(notification({ kind: "inbox", worktreePath: "/repo/.worktrees/b" }));

    expect(switchWorktree.mock.calls).toEqual([[localRef("/repo/.worktrees/b")]]);
  });

  test("activates the terminal's tab, whose panel id is not the terminal's", () => {
    const panel = (id: string, params: object) => ({ id, params, api: { setActive: mock() } });
    // A panel whose id happens to be the terminal id must not be taken for its tab.
    const decoy = panel("terminal-1", {});
    const tab = panel("terminal-terminal-1", { terminalId: "terminal-1" });
    setCenterApi(
      { panels: [decoy, tab] } as unknown as DockviewApi,
      layoutKeyOf(localRef("/repo")),
    );

    navigateToNotification(notification(terminalIn("/repo")));

    expect(tab.api.setActive).toHaveBeenCalledTimes(1);
    expect(decoy.api.setActive).not.toHaveBeenCalled();
  });
});
