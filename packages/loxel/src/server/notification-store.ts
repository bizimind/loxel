/**
 * Server-side in-memory notification store.
 *
 * Generic notification model: terminals, browser panel pages and the server itself are its
 * sources, told apart by `source.kind`.
 *
 * Ephemeral: state is lost on server restart (matches current notification behavior).
 * All connected clients are kept in sync via WS broadcasts from the caller.
 */
import {
  type BrowserNotificationSource,
  type NotificationSource,
  type ServerNotification,
  isPanelSource,
} from "@/api/notification-model";

const MAX_NOTIFICATIONS = 200;
/**
 * Browser pages' share of the list: a busy or misbehaving site evicts its own kind's oldest
 * notifications, never the terminals' that tell the user an agent is waiting.
 */
const MAX_BROWSER_NOTIFICATIONS = 50;

export class NotificationStore {
  private notifications: ServerNotification[] = [];

  add(input: Omit<ServerNotification, "id" | "timestamp">): ServerNotification {
    const notification: ServerNotification = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    this.notifications.unshift(notification);
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications.length = MAX_NOTIFICATIONS;
    }
    return notification;
  }

  /**
   * Add a browser page's notification, evicting the oldest browser ones past their share. Returns
   * it and the ids evicted.
   */
  addBrowser(input: Omit<ServerNotification, "id" | "timestamp">): {
    added: ServerNotification;
    evicted: string[];
  } {
    const added = this.add(input);
    const browser = this.notifications.filter((n) => n.source.kind === "browser");
    const excess = new Set(browser.slice(MAX_BROWSER_NOTIFICATIONS).map((n) => n.id));
    if (excess.size > 0) this.notifications = this.notifications.filter((n) => !excess.has(n.id));
    return { added, evicted: [...excess] };
  }

  dismiss(id: string): boolean {
    const idx = this.notifications.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    this.notifications.splice(idx, 1);
    return true;
  }

  dismissByPanel(panelId: string): boolean {
    return this.dismissWhere((s) => isPanelSource(s) && s.panelId === panelId).length > 0;
  }

  /** Remove the notifications whose source matches, returning their ids. */
  dismissWhere(matches: (source: NotificationSource) => boolean): string[] {
    const removed: string[] = [];
    this.notifications = this.notifications.filter((n) => {
      if (!matches(n.source)) return true;
      removed.push(n.id);
      return false;
    });
    return removed;
  }

  /**
   * Remove what a new browser notification replaces: like browsers, its origin's earlier
   * notifications with the same tag, in the same worktree (or Home): the same dev server port in
   * two worktrees is two apps. Returns their ids.
   */
  dismissReplacedBy(source: BrowserNotificationSource): string[] {
    if (!source.tag) return [];
    return this.dismissWhere(
      (s) =>
        s.kind === "browser" &&
        s.origin === source.origin &&
        s.tag === source.tag &&
        s.worktreePath === source.worktreePath,
    );
  }

  /** Dismiss what a worktree's panels raised. Returns the panels that had notifications. */
  dismissByWorktree(worktreePath: string): string[] {
    const panelIds = new Set<string>();
    this.notifications = this.notifications.filter((n) => {
      if (!isPanelSource(n.source) || n.source.worktreePath !== worktreePath) return true;
      panelIds.add(n.source.panelId);
      return false;
    });
    return [...panelIds];
  }

  dismissAll(): void {
    this.notifications = [];
  }

  getAll(): readonly ServerNotification[] {
    return this.notifications;
  }
}
