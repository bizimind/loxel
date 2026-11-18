/**
 * Panel notification state.
 *
 * Server is the source of truth — notifications come from terminal output (detected server-side)
 * and from browser panel pages, and this store mirrors WS broadcasts. Multiple loxel instances
 * stay in sync via the server-side NotificationStore.
 *
 * Tracks which panels have unread notifications so that:
 * - Panel tabs show a badge dot when the tab is not active
 * - Worktree sidebar items show a badge dot when the worktree is not active
 * - The notification center overlay shows a scrollable list
 */
import { create } from "zustand";

import { wsClient } from "@/api/client";
import { type ServerNotification, isPanelSource } from "@/api/notification-model";
import {
  type ServerId,
  type WorktreeRef,
  type WorktreeRefKey,
  formatWorktreeRef,
  worktreeRef,
} from "@/api/worktree-ref";

/**
 * A notification and the server that sent it. The worktree paths in its source are on that server;
 * the server's own form of it ({@link ServerNotification}) names none.
 */
export interface ClientNotification extends ServerNotification {
  readonly server: ServerId;
}

function extractPanelId(n: ServerNotification): string | undefined {
  return isPanelSource(n.source) ? n.source.panelId : undefined;
}

/**
 * The worktree a notification's source names: null for Home, undefined when it names none (an
 * inbox notification that opened in whatever the window showed, or the server's own).
 */
export function notificationWorktree(n: ClientNotification): WorktreeRef | null | undefined {
  const { source } = n;
  if (source.kind !== "inbox" && !isPanelSource(source)) return undefined;
  const path = source.worktreePath;
  return typeof path === "string" ? worktreeRef(n.server, path) : path;
}

function buildIndexes(notifications: readonly ClientNotification[]): {
  panelIndex: Set<string>;
  worktreeIndex: Set<WorktreeRefKey>;
} {
  const panelIndex = new Set<string>();
  const worktreeIndex = new Set<WorktreeRefKey>();
  for (const n of notifications) {
    const pid = extractPanelId(n);
    if (pid) panelIndex.add(pid);
    // Only panels' notifications mark their worktree; a Home panel's (null) marks none.
    const wt = isPanelSource(n.source) ? notificationWorktree(n) : undefined;
    if (wt) worktreeIndex.add(formatWorktreeRef(wt));
  }
  return { panelIndex, worktreeIndex };
}

interface PanelNotificationState {
  /** Ordered notification list (newest first). */
  notifications: ClientNotification[];

  /** Derived: panelIds with at least one notification. Rebuilt on every mutation. */
  panelIndex: Set<string>;
  /** Derived: worktrees with at least one panel notification. Rebuilt on every mutation. */
  worktreeIndex: Set<WorktreeRefKey>;

  /** Dismiss a closed panel's notifications on the server. */
  unregisterPanel: (panelId: string) => void;

  /** Server-sync: replace all notifications (`server` sends them on connect/reconnect). */
  syncAll: (server: ServerId, notifications: readonly ServerNotification[]) => void;
  /** Server-sync: add a notification `server` broadcast. */
  addFromServer: (server: ServerId, notification: ServerNotification) => void;
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
export function hasWorktreeNotification(s: PanelNotificationState, wt: WorktreeRef): boolean {
  return s.worktreeIndex.has(formatWorktreeRef(wt));
}

export const usePanelNotificationStore = create<PanelNotificationState>()((set) => ({
  notifications: [],
  panelIndex: new Set(),
  worktreeIndex: new Set(),

  unregisterPanel: (panelId) => {
    wsClient.send({ type: "notification_dismiss_panel", panelId });
  },

  // --- Server sync ---

  syncAll: (server, incoming) => {
    const notifications = incoming.map((n) => ({ ...n, server }));
    const { panelIndex, worktreeIndex } = buildIndexes(notifications);
    set({ notifications, panelIndex, worktreeIndex });
  },

  addFromServer: (server, notification) =>
    set((s) => {
      const notifications = [{ ...notification, server }, ...s.notifications];
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
