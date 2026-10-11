/**
 * Panel notification state.
 *
 * Server is the source of truth — notifications are detected server-side from terminal output
 * and this store mirrors WS broadcasts. Multiple loxel instances stay in sync via the
 * server-side NotificationStore.
 *
 * Tracks which panels have unread notifications so that:
 * - Panel tabs show a badge dot when the tab is not active
 * - Worktree sidebar items show a badge dot when the worktree is not active
 * - The notification center overlay shows a scrollable list
 */
import { create } from "zustand";

import { wsClient } from "@/api/client";
import type { ServerNotification } from "@/api/notification-model";

function extractPanelId(n: ServerNotification): string | undefined {
  if (n.source.kind === "terminal") return n.source.panelId;
  return undefined;
}

function extractWorktreePath(n: ServerNotification): string | undefined {
  if (n.source.kind === "terminal") return n.source.worktreePath;
  return undefined;
}

function buildIndexes(notifications: readonly ServerNotification[]): {
  panelIndex: Set<string>;
  worktreeIndex: Set<string>;
} {
  const panelIndex = new Set<string>();
  const worktreeIndex = new Set<string>();
  for (const n of notifications) {
    const pid = extractPanelId(n);
    if (pid) panelIndex.add(pid);
    const wtp = extractWorktreePath(n);
    if (wtp) worktreeIndex.add(wtp);
  }
  return { panelIndex, worktreeIndex };
}

interface PanelNotificationState {
  /** Ordered notification list (newest first). */
  notifications: ServerNotification[];

  /** Derived: panelIds with at least one notification. Rebuilt on every mutation. */
  panelIndex: Set<string>;
  /** Derived: worktreePaths with at least one notification. Rebuilt on every mutation. */
  worktreeIndex: Set<string>;

  /** Dismiss a closed panel's notifications on the server. */
  unregisterPanel: (panelId: string) => void;

  /** Server-sync: replace all notifications (sent on connect/reconnect). */
  syncAll: (notifications: readonly ServerNotification[]) => void;
  /** Server-sync: add a notification broadcast by the server. */
  addFromServer: (notification: ServerNotification) => void;
  /** Server-sync: remove a notification by id. */
  removeFromServer: (id: string) => void;
  /** Server-sync: remove all notifications for a panel. */
  removePanelFromServer: (panelId: string) => void;
  /** Server-sync: clear all notifications. */
  clearFromServer: () => void;

  /** User action: dismiss a single notification (sends to server). */
  dismiss: (id: string) => void;
  /** User action: dismiss all notifications for a panel (sends to server). */
  dismissPanel: (panelId: string) => void;
  /** User action: dismiss all notifications (sends to server). */
  dismissAll: () => void;
}

/** Selector: returns true if the given panel has an unread notification. */
export function hasPanelNotification(s: PanelNotificationState, panelId: string): boolean {
  return s.panelIndex.has(panelId);
}

/** Selector: returns true if any panel in the given worktree has an unread notification. */
export function hasWorktreeNotification(s: PanelNotificationState, worktreePath: string): boolean {
  return s.worktreeIndex.has(worktreePath);
}

export const usePanelNotificationStore = create<PanelNotificationState>()((set) => ({
  notifications: [],
  panelIndex: new Set(),
  worktreeIndex: new Set(),

  unregisterPanel: (panelId) => {
    wsClient.send({ type: "notification_dismiss_panel", panelId });
  },

  // --- Server sync ---

  syncAll: (incoming) => {
    const notifications = [...incoming];
    const { panelIndex, worktreeIndex } = buildIndexes(notifications);
    set({ notifications, panelIndex, worktreeIndex });
  },

  addFromServer: (notification) =>
    set((s) => {
      const notifications = [notification, ...s.notifications];
      const { panelIndex, worktreeIndex } = buildIndexes(notifications);
      return { notifications, panelIndex, worktreeIndex };
    }),

  removeFromServer: (id) =>
    set((s) => {
      const notifications = s.notifications.filter((n) => n.id !== id);
      if (notifications.length === s.notifications.length) return s;
      const { panelIndex, worktreeIndex } = buildIndexes(notifications);
      return { notifications, panelIndex, worktreeIndex };
    }),

  removePanelFromServer: (panelId) =>
    set((s) => {
      const notifications = s.notifications.filter((n) => extractPanelId(n) !== panelId);
      if (notifications.length === s.notifications.length) return s;
      const { panelIndex, worktreeIndex } = buildIndexes(notifications);
      return { notifications, panelIndex, worktreeIndex };
    }),

  clearFromServer: () =>
    set({ notifications: [], panelIndex: new Set(), worktreeIndex: new Set() }),

  // --- User actions (optimistic + send to server) ---

  dismiss: (id) => {
    wsClient.send({ type: "notification_dismiss", id });
    // Optimistic removal handled by removeFromServer when broadcast arrives
  },

  dismissPanel: (panelId) => {
    wsClient.send({ type: "notification_dismiss_panel", panelId });
  },

  dismissAll: () => {
    wsClient.send({ type: "notifications_clear" });
  },
}));
