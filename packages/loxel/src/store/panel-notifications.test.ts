import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { wsClient } from "@/api/client";
import { localServerId } from "@/api/local-server";
import type { ServerNotification } from "@/api/notification-model";
import { toServerId, worktreeRef } from "@/api/worktree-ref";
import type { WsClientMessage } from "@/api/ws-protocol";

import {
  hasPanelNotification,
  hasWorktreeNotification,
  notificationWorktree,
  usePanelNotificationStore,
} from "./panel-notifications";

const HERE = toServerId("server-here");
const THERE = toServerId("server-there");

function terminal(id: string, worktreePath: string | null, timestamp = 0): ServerNotification {
  return {
    id,
    timestamp,
    source: { kind: "terminal", panelId: `panel-${id}`, worktreePath },
    urgency: "normal",
  };
}

afterEach(() => usePanelNotificationStore.setState({ notifications: [] }));

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
    usePanelNotificationStore.getState().removeFromServer(THERE, "b");
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

describe("panel notifications of two servers", () => {
  const store = () => usePanelNotificationStore.getState();
  const ids = () => store().notifications.map((n) => `${n.server}/${n.id}`);

  test("a server's sync replaces its own notifications and keeps the other's, newest first", () => {
    store().syncAll(HERE, [terminal("a", "/repo", 1)]);
    store().syncAll(THERE, [terminal("b", "/repo", 3), terminal("c", "/repo", 2)]);
    store().syncAll(HERE, [terminal("d", "/repo", 4)]);

    expect(ids()).toEqual([`${HERE}/d`, `${THERE}/b`, `${THERE}/c`]);
  });

  test("the same id and panel on two servers are told apart", () => {
    store().syncAll(HERE, [terminal("a", "/repo")]);
    store().syncAll(THERE, [terminal("a", "/repo")]);
    expect(hasPanelNotification(store(), HERE, "panel-a")).toBe(true);
    expect(hasPanelNotification(store(), THERE, "panel-a")).toBe(true);

    store().removeFromServer(THERE, "a");
    expect(ids()).toEqual([`${HERE}/a`]);
    expect(hasPanelNotification(store(), THERE, "panel-a")).toBe(false);

    store().syncAll(THERE, [terminal("a", "/repo")]);
    store().removePanelFromServer(HERE, "panel-a");
    expect(ids()).toEqual([`${THERE}/a`]);
    expect(hasWorktreeNotification(store(), worktreeRef(HERE, "/repo"))).toBe(false);
  });

  test("a server's clear leaves the other server's notifications", () => {
    store().syncAll(HERE, [terminal("a", "/repo")]);
    store().syncAll(THERE, [terminal("b", "/repo")]);

    store().clearFromServer(THERE);

    expect(ids()).toEqual([`${HERE}/a`]);
  });

  test("a dismissal goes to the server that raised the notification", () => {
    const sent: WsClientMessage[] = [];
    const send = spyOn(wsClient, "send").mockImplementation((message) => {
      sent.push(message);
    });
    try {
      const local = localServerId();
      store().syncAll(local, [terminal("a", "/repo")]);
      store().syncAll(THERE, [terminal("a", "/repo")]);
      const [mine, theirs] = [local, THERE].map((server) =>
        store().notifications.find((n) => n.server === server)!,
      );

      store().dismiss(mine!);
      expect(sent).toEqual([{ type: "notification_dismiss", id: "a" }]);
      // The window has no connection to that server: dropped, never sent to its own instead.
      expect(() => store().dismiss(theirs!)).not.toThrow();
      expect(() => store().dismissPanel(THERE, "panel-a")).not.toThrow();
      expect(() => store().unregisterPanel(THERE, "panel-a")).not.toThrow();
      expect(sent).toEqual([{ type: "notification_dismiss", id: "a" }]);
    } finally {
      send.mockRestore();
    }
  });

  test("clearing all tells every connected server, past one the window can't reach", () => {
    const sent: WsClientMessage[] = [];
    const send = spyOn(wsClient, "send").mockImplementation((message) => {
      sent.push(message);
    });
    try {
      store().syncAll(THERE, [terminal("b", "/repo", 2)]);
      store().syncAll(localServerId(), [terminal("a", "/repo", 1)]);

      store().dismissAll();

      expect(sent).toEqual([{ type: "notifications_clear" }]);
    } finally {
      send.mockRestore();
    }
  });
});
