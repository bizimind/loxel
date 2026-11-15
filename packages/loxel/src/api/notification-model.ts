/** A terminal program raised the notification with an OSC sequence. */
export interface TerminalNotificationSource {
  kind: "terminal";
  panelId: string;
  /** The terminal's worktree, or null for a Home terminal. */
  worktreePath: string | null;
}

/** A page in a browser panel raised the notification with the web Notification API. */
export interface BrowserNotificationSource {
  kind: "browser";
  panelId: string;
  /** The worktree whose layout holds the panel, or null for a Home browser panel. */
  worktreePath: string | null;
  /** The page's origin, like `http://localhost:5173`. */
  origin: string;
  /** Main-process id of the page's `Notification` object, for its `click` event and `close()`. */
  ref: string;
  /** The page's `tag`: a new notification replaces the origin's earlier one with the same tag. */
  tag?: string;
}

/** The server itself, about the terminal hosts (terminals it had to end at startup). */
export interface TerminalHostNotificationSource {
  kind: "terminal_host";
}

/** Source identifies where a notification came from. */
export type NotificationSource =
  | TerminalNotificationSource
  | BrowserNotificationSource
  | TerminalHostNotificationSource;

/** Sources raised by a panel, in its worktree or in Home: navigable, with a tab dot. */
export type PanelNotificationSource = TerminalNotificationSource | BrowserNotificationSource;

export function isPanelSource(source: NotificationSource): source is PanelNotificationSource {
  return source.kind === "terminal" || source.kind === "browser";
}

export interface ServerNotification {
  id: string;
  timestamp: number;
  source: NotificationSource;
  title?: string;
  body?: string;
  urgency: "low" | "normal" | "high" | "critical";
}
