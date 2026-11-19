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

import { wsClientOf } from "@/api/client";
import { type ServerNotification, isPanelSource } from "@/api/notification-model";
import { hasConnection } from "@/api/server-connection";
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

/** The key of panel `panelId` of `server` in the panel index: panel ids are unique per server only. */
export type PanelNotificationKey = string & { readonly panelNotificationKeyBrand: unique symbol };

export function panelNotificationKey(server: ServerId, panelId: string): PanelNotificationKey {
  return `${server}:${panelId}` as PanelNotificationKey;
}

function buildIndexes(notifications: readonly ClientNotification[]): {
  panelIndex: Set<PanelNotificationKey>;
  worktreeIndex: Set<WorktreeRefKey>;
} {
  const panelIndex = new Set<PanelNotificationKey>();
  const worktreeIndex = new Set<WorktreeRefKey>();
  for (const n of notifications) {
    const pid = extractPanelId(n);
    if (pid) panelIndex.add(panelNotificationKey(n.server, pid));
    // Only panels' notifications mark their worktree; a Home panel's (null) marks none.
    const wt = isPanelSource(n.source) ? notificationWorktree(n) : undefined;
    if (wt) worktreeIndex.add(formatWorktreeRef(wt));
  }
  return { panelIndex, worktreeIndex };
}

/** The state for `notifications`, with its indexes. */
function withIndexes(
  notifications: ClientNotification[],
): Pick<PanelNotificationState, "notifications" | "panelIndex" | "worktreeIndex"> {
  return { notifications, ...buildIndexes(notifications) };
}

/**
 * `notifications` without those of `server` that `drop` matches, or the same array when none does,
 * so a removal that changes nothing changes no state.
 */
function without(
  notifications: ClientNotification[],
  server: ServerId,
  drop: (n: ClientNotification) => boolean,
): ClientNotification[] {
  const kept = notifications.filter((n) => n.server !== server || !drop(n));
  return kept.length === notifications.length ? notifications : kept;
}

interface PanelNotificationState {
  /** Ordered notification list (newest first), of every server. */
  notifications: ClientNotification[];

  /** Derived: panels with at least one notification, by server and id. Rebuilt on every mutation. */
  panelIndex: Set<PanelNotificationKey>;
  /** Derived: worktrees with at least one panel notification. Rebuilt on every mutation. */
  worktreeIndex: Set<WorktreeRefKey>;

  /** Dismiss a closed panel's notifications on `server`, which holds the panel. */
  unregisterPanel: (server: ServerId, panelId: string) => void;

  /**
   * Server-sync: replace `server`'s notifications (it sends them on connect/reconnect), keeping
   * other servers'.
   */
  syncAll: (server: ServerId, notifications: readonly ServerNotification[]) => void;
  /** Server-sync: add a notification `server` broadcast. */
  addFromServer: (server: ServerId, notification: ServerNotification) => void;
  /** Server-sync: remove `server`'s notification `id`. */
  removeFromServer: (server: ServerId, id: string) => void;
  /** Server-sync: remove all of `server`'s notifications for its panel `panelId`. */
  removePanelFromServer: (server: ServerId, panelId: string) => void;
  /** Server-sync: clear all of `server`'s notifications. */
  clearFromServer: (server: ServerId) => void;

  /** User action: dismiss a single notification (sends to the server that raised it). */
  dismiss: (notification: ClientNotification) => void;
  /** User action: dismiss all notifications of `server`'s panel `panelId` (sends to it). */
  dismissPanel: (server: ServerId, panelId: string) => void;
  /**
   * User action: dismiss all notifications (sends to every server the list holds some of that the
   * window is connected to).
   */
  dismissAll: () => void;
}

/** Selector: returns true if `server`'s panel `panelId` has an unread notification. */
export function hasPanelNotification(
  s: Pick<PanelNotificationState, "panelIndex">,
  server: ServerId,
  panelId: string,
): boolean {
  return s.panelIndex.has(panelNotificationKey(server, panelId));
}

/** Selector: returns true if any panel in the given worktree has an unread notification. */
export function hasWorktreeNotification(s: PanelNotificationState, wt: WorktreeRef): boolean {
  return s.worktreeIndex.has(formatWorktreeRef(wt));
}

/** Newest first, across servers: ids are only unique per server, so this keeps their own order. */
function newestFirst(a: ClientNotification, b: ClientNotification): number {
  return b.timestamp - a.timestamp;
}

export const usePanelNotificationStore = create<PanelNotificationState>()((set, get) => ({
  notifications: [],
  panelIndex: new Set(),
  worktreeIndex: new Set(),

  unregisterPanel: (server, panelId) => {
    wsClientOf(server).send({ type: "notification_dismiss_panel", panelId });
  },

  // --- Server sync ---

  syncAll: (server, incoming) =>
    set((s) => {
      const others = s.notifications.filter((n) => n.server !== server);
      const mine = incoming.map((n) => ({ ...n, server }));
      // Each server's list is newest first already; merging keeps that across them.
      const notifications = others.length === 0 ? mine : [...others, ...mine].sort(newestFirst);
      return withIndexes(notifications);
    }),

  addFromServer: (server, notification) =>
    set((s) => withIndexes([{ ...notification, server }, ...s.notifications])),

  removeFromServer: (server, id) =>
    set((s) => {
      const notifications = without(s.notifications, server, (n) => n.id === id);
      return notifications === s.notifications ? s : withIndexes(notifications);
    }),

  removePanelFromServer: (server, panelId) =>
    set((s) => {
      const notifications = without(s.notifications, server, (n) => extractPanelId(n) === panelId);
      return notifications === s.notifications ? s : withIndexes(notifications);
    }),

  clearFromServer: (server) =>
    set((s) => {
      const notifications = without(s.notifications, server, () => true);
      return notifications === s.notifications ? s : withIndexes(notifications);
    }),

  // --- User actions (sent to the server; removed when its broadcast arrives) ---

  dismiss: ({ server, id }) => {
    wsClientOf(server).send({ type: "notification_dismiss", id });
  },

  dismissPanel: (server, panelId) => {
    wsClientOf(server).send({ type: "notification_dismiss_panel", panelId });
  },

  dismissAll: () => {
    for (const server of new Set(get().notifications.map((n) => n.server))) {
      // A server the window has no connection to can't be told; the others still are.
      if (hasConnection(server)) wsClientOf(server).send({ type: "notifications_clear" });
    }
  },
}));
