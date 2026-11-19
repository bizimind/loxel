import type { ClientNotification } from "@/store/panel-notifications";

type NonEmpty<T> = [T, ...T[]];

/**
 * A row of the notification center: one notification, or a site's stacked together. `key` is
 * unique among the rows.
 */
export type NotificationEntry =
  | { kind: "single"; key: string; notification: ClientNotification }
  /** Two or more notifications from one site in one worktree (or Home), newest first. */
  | { kind: "site"; key: string; notifications: NonEmpty<ClientNotification> };

/**
 * Stack each site's browser notifications into one entry, placed where its newest is, so a busy
 * site doesn't bury the terminals' notifications. A site is an origin in one worktree (or Home),
 * as for tags: the same dev server port in two worktrees, or on two servers, is two apps. Other
 * sources stay single.
 * Expects the store's newest-first list and keeps that order.
 */
export function groupNotifications(
  notifications: readonly ClientNotification[],
): NotificationEntry[] {
  // Insertion-ordered: each row sits where its newest is. Other sources key by their server and
  // id (ids are unique per server only), a pair a site's three-part key never equals.
  const rows = new Map<string, NonEmpty<ClientNotification>>();
  for (const n of notifications) {
    const key =
      n.source.kind === "browser"
        ? JSON.stringify([n.source.origin, n.server, n.source.worktreePath])
        : JSON.stringify([n.server, n.id]);
    const row = rows.get(key);
    if (row) row.push(n);
    else rows.set(key, [n]);
  }
  return [...rows].map(([key, row]): NotificationEntry =>
    row.length === 1
      ? { kind: "single", key, notification: row[0] }
      : { kind: "site", key, notifications: row },
  );
}
