import { afterEach, describe, expect, test } from "bun:test";

import type { ServerNotification } from "@/api/notification-model";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

import {
  hasWorktreeNotification,
  notificationWorktree,
  usePanelNotificationStore,
} from "./panel-notifications";

const HERE = toServerId("server-here");
const THERE = toServerId("server-there");

function terminal(id: string, worktreePath: string | null): ServerNotification {
  return {
    id,
    timestamp: 0,
    source: { kind: "terminal", panelId: `panel-${id}`, worktreePath },
    urgency: "normal",
  };
}

afterEach(() => usePanelNotificationStore.getState().clearFromServer());

describe("panel notifications by worktree ref", () => {
  test("mark the worktree on the server that sent them, not the same path elsewhere", () => {
    usePanelNotificationStore.getState().syncAll(HERE, [terminal("a", "/repo")]);
    const state = usePanelNotificationStore.getState();

    expect(hasWorktreeNotification(state, worktreeRef(HERE, "/repo"))).toBe(true);
    expect(hasWorktreeNotification(state, worktreeRef(THERE, "/repo"))).toBe(false);
  });

  test("a later notification from another server marks its own worktree", () => {
    usePanelNotificationStore.getState().syncAll(HERE, [terminal("a", "/repo")]);
    usePanelNotificationStore.getState().addFromServer(THERE, terminal("b", "/repo"));
    const state = usePanelNotificationStore.getState();

    expect(state.notifications.map((n) => n.server)).toEqual([THERE, HERE]);
    expect(hasWorktreeNotification(state, worktreeRef(THERE, "/repo"))).toBe(true);
    usePanelNotificationStore.getState().removeFromServer("b");
    expect(
      hasWorktreeNotification(usePanelNotificationStore.getState(), worktreeRef(THERE, "/repo")),
    ).toBe(false);
  });

  test("a Home panel's notification marks no worktree", () => {
    usePanelNotificationStore.getState().syncAll(HERE, [terminal("home", null)]);

    expect(usePanelNotificationStore.getState().worktreeIndex.size).toBe(0);
  });

  test("names the worktree, Home or nothing a notification's source points at", () => {
    const [panel, home] = [terminal("a", "/repo"), terminal("b", null)].map((n) => ({
      ...n,
      server: THERE,
    }));
    const inbox = { ...terminal("c", null), source: { kind: "inbox" as const }, server: THERE };

    expect(notificationWorktree(panel!)).toEqual(worktreeRef(THERE, "/repo"));
    expect(notificationWorktree(home!)).toBeNull();
    expect(notificationWorktree(inbox)).toBeUndefined();
  });
});
