import type { WsClientMessage } from "./ws-protocol";

/**
 * The app socket's state as the window shows it: `connecting` until the first server hello,
 * `connected` from then on, and `reconnecting` whenever the socket is down after that.
 */
export type ConnectionState = "connecting" | "connected" | "reconnecting";

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 10_000;

/**
 * How long to wait before reconnect attempt `attempt` (0 for the first): doubling from 250 ms up
 * to 10 s, then a random point in the upper half of that, so the windows of a restarted server do
 * not all retry at the same moment.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return ceiling / 2 + (random() * ceiling) / 2;
}

/**
 * Whether a message queued while the socket was down is still sent once it is back. A new socket
 * starts with no server-side state, which the reconnect listeners rebuild (worktree and log
 * subscriptions, terminal attachments, window identity), so messages about that state are dropped:
 * sending them too would duplicate it or act on a socket that is gone. What the user asked for
 * meanwhile (close a terminal, dismiss a notification) is sent after the listeners have run.
 */
const SENT_AFTER_RECONNECT: Record<WsClientMessage["type"], boolean> = {
  subscribe_worktree: false,
  unsubscribe_worktree: false,
  subscribe_logs: false,
  unsubscribe_logs: false,
  terminal_attach: false,
  terminal_detach: false,
  terminal_resize: false,
  terminal_ack: false,
  terminal_destroy: true,
  close_external_file: true,
  register_external_files: false,
  window_hello: false,
  window_focused: false,
  notification_dismiss: true,
  notification_dismiss_panel: true,
  notifications_clear: true,
  browser_notification_show: true,
};

export function sentAfterReconnect(message: WsClientMessage): boolean {
  return SENT_AFTER_RECONNECT[message.type];
}
