/**
 * Server-side in-memory notification store.
 *
 * Generic notification model — not tied to terminals. Future notification sources
 * (CI, coding-agent, etc.) can use the same system by adding new source kinds.
 *
 * Ephemeral: state is lost on server restart (matches current notification behavior).
 * All connected clients are kept in sync via WS broadcasts from the caller.
 */
import type { ServerNotification } from "@/api/notification-model";

const MAX_NOTIFICATIONS = 200;

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

  dismiss(id: string): boolean {
    const idx = this.notifications.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    this.notifications.splice(idx, 1);
    return true;
  }

  dismissByPanel(panelId: string): boolean {
    const before = this.notifications.length;
    this.notifications = this.notifications.filter(
      (n) => !(n.source.kind === "terminal" && n.source.panelId === panelId),
    );
    return this.notifications.length !== before;
  }

  dismissAll(): void {
    this.notifications = [];
  }

  getAll(): readonly ServerNotification[] {
    return this.notifications;
  }
}
