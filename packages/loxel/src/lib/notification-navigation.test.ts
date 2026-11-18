import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";
import type { NotificationSource } from "@/api/notification-model";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import type { ClientNotification } from "@/store/panel-notifications";
import { activeWorktreeFields, useWorktreeStore } from "@/store/worktrees";

import { navigateToNotification } from "./notification-navigation";

const ELSEWHERE = toServerId("elsewhere");
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
  switchWorktree.mockClear();
  showHome.mockClear();
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
    navigateToNotification(notification(terminalIn("/repo"), ELSEWHERE));

    expect(switchWorktree.mock.calls).toEqual([[worktreeRef(ELSEWHERE, "/repo")]]);
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
});
