/**
 * The server's notifications, newest first.
 *
 * Generic notification model: terminals, browser panel pages, the open inbox and the server itself
 * are its sources, told apart by `source.kind`.
 *
 * Persisted: every change is written through to its SQLite file, so a restart keeps the list,
 * dismissals included. All connected clients are kept in sync via WS broadcasts from the caller.
 */
import {
  type BrowserNotificationSource,
  type NotificationSource,
  type ServerNotification,
  ServerNotificationSchema,
  isPanelSource,
} from "@/api/notification-model";

import { PersistedList } from "./persisted-list";

const MAX_NOTIFICATIONS = 200;
/**
 * Browser pages' share of the list: a busy or misbehaving site evicts its own kind's oldest
 * notifications, never the terminals' that tell the user an agent is waiting.
 */
const MAX_BROWSER_NOTIFICATIONS = 50;

export class NotificationStore {
  private notifications: ServerNotification[];
  private readonly persisted: PersistedList<ServerNotification>;

  /** `path` is the SQLite file to keep the list in; null keeps it in memory only. */
  constructor(path: string | null = null) {
    this.persisted = new PersistedList(path, ServerNotificationSchema);
    this.notifications = this.persisted.load().toReversed();
    // A list persisted under a larger cap, or by a store whose trims did not reach the file.
    this.removeWhere((_, index) => index >= MAX_NOTIFICATIONS);
  }

  add(input: Omit<ServerNotification, "id" | "timestamp">): ServerNotification {
    const notification: ServerNotification = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    this.notifications.unshift(notification);
    this.persisted.insert(notification);
    this.removeWhere((_, index) => index >= MAX_NOTIFICATIONS);
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
    return { added, evicted: this.removeWhere((n) => excess.has(n.id)) };
  }

  dismiss(id: string): boolean {
    return this.removeWhere((n) => n.id === id).length > 0;
  }

  dismissByPanel(panelId: string): boolean {
    return this.dismissWhere((s) => isPanelSource(s) && s.panelId === panelId).length > 0;
  }

  /** Remove the notifications whose source matches, returning their ids. */
  dismissWhere(matches: (source: NotificationSource) => boolean): string[] {
    return this.removeWhere((n) => matches(n.source));
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

  /**
   * Dismiss what a worktree's panels and its inbox raised. Returns the panels that had
   * notifications, and the ids of the inbox's.
   */
  dismissByWorktree(worktreePath: string): { panelIds: string[]; inboxIds: string[] } {
    const panelIds = new Set<string>();
    const inboxIds: string[] = [];
    this.removeWhere(({ id, source }) => {
      if (source.kind === "inbox" && source.worktreePath === worktreePath) {
        inboxIds.push(id);
        return true;
      }
      if (!isPanelSource(source) || source.worktreePath !== worktreePath) return false;
      panelIds.add(source.panelId);
      return true;
    });
    return { panelIds: [...panelIds], inboxIds };
  }

  dismissAll(): void {
    this.notifications = [];
    this.persisted.clear();
  }

  getAll(): readonly ServerNotification[] {
    return this.notifications;
  }

  /** Close the file the list is kept in. */
  close(): void {
    this.persisted.close();
  }

  /** Remove the notifications that match, from memory and the file. Returns their ids. */
  private removeWhere(matches: (n: ServerNotification, index: number) => boolean): string[] {
    const removed: string[] = [];
    this.notifications = this.notifications.filter((n, index) => {
      if (!matches(n, index)) return true;
      removed.push(n.id);
      return false;
    });
    this.persisted.delete(removed);
    return removed;
  }
}
