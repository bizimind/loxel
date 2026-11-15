import type { ServerNotification } from "@/api/notification-model";

type NonEmpty<T> = [T, ...T[]];

/** A row of the notification center: one notification, or a site's stacked together. */
export type NotificationEntry =
  | { kind: "single"; notification: ServerNotification }
  /** Two or more notifications from one site in one worktree (or Home), newest first. */
  | { kind: "site"; key: string; notifications: NonEmpty<ServerNotification> };

/**
 * Stack each site's browser notifications into one entry, placed where its newest is, so a busy
 * site doesn't bury the terminals' notifications. A site is an origin in one worktree (or Home),
 * as for tags: the same dev server port in two worktrees is two apps. Other sources stay single.
 * Expects the store's newest-first list and keeps that order.
 */
export function groupNotifications(
  notifications: readonly ServerNotification[],
): NotificationEntry[] {
  const sites = new Map<string, NonEmpty<ServerNotification>>();
  const rows: (ServerNotification | { key: string; site: NonEmpty<ServerNotification> })[] = [];
  for (const n of notifications) {
    if (n.source.kind !== "browser") {
      rows.push(n);
      continue;
    }
    const key = JSON.stringify([n.source.origin, n.source.worktreePath]);
    const site = sites.get(key);
    if (site) {
      site.push(n);
      continue;
    }
    const created: NonEmpty<ServerNotification> = [n];
    sites.set(key, created);
    rows.push({ key, site: created });
  }

  return rows.map((row): NotificationEntry => {
    if (!("site" in row)) return { kind: "single", notification: row };
    if (row.site.length === 1) return { kind: "single", notification: row.site[0] };
    return { kind: "site", key: row.key, notifications: row.site };
  });
}
