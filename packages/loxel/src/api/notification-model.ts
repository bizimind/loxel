/**
 * The notifications the server keeps and sends every window. The server persists all but browser
 * pages' ones, so it parses what it reads back with these schemas.
 */
import { z } from "zod";

/** A terminal program raised the notification with an OSC sequence. */
export const TerminalNotificationSourceSchema = z.object({
  kind: z.literal("terminal"),
  panelId: z.string(),
  /** The terminal's worktree, or null for a Home terminal. */
  worktreePath: z.string().nullable(),
});
export type TerminalNotificationSource = z.infer<typeof TerminalNotificationSourceSchema>;

/** A page in a browser panel raised the notification with the web Notification API. */
export const BrowserNotificationSourceSchema = z.object({
  kind: z.literal("browser"),
  panelId: z.string(),
  /** The worktree whose layout holds the panel, or null for a Home browser panel. */
  worktreePath: z.string().nullable(),
  /** The page's origin, like `http://localhost:5173`. */
  origin: z.string(),
  /** Main-process id of the page's `Notification` object, for its `click` event and `close()`. */
  ref: z.string(),
  /** The page's `tag`: a new notification replaces the origin's earlier one with the same tag. */
  tag: z.string().optional(),
  /** The favicon the panel's tab showed for the page when it notified, for the bell's icon. */
  faviconUrl: z.string().optional(),
});
export type BrowserNotificationSource = z.infer<typeof BrowserNotificationSourceSchema>;

/**
 * Panels that `loxel` asked for while no window was open, opened in a window that connected later:
 * in the worktree named, in Home (null), or, when absent, in whatever the window showed.
 */
export const InboxNotificationSourceSchema = z.object({
  kind: z.literal("inbox"),
  worktreePath: z.string().nullable().optional(),
});
export type InboxNotificationSource = z.infer<typeof InboxNotificationSourceSchema>;

/**
 * The server itself: terminals it had to end at startup, or a `loxel` CLI socket it could not
 * listen on.
 */
export const ServerNotificationSourceSchema = z.object({ kind: z.literal("server") });
export type ServerNotificationSource = z.infer<typeof ServerNotificationSourceSchema>;

/** Source identifies where a notification came from. */
export const NotificationSourceSchema = z.discriminatedUnion("kind", [
  TerminalNotificationSourceSchema,
  BrowserNotificationSourceSchema,
  InboxNotificationSourceSchema,
  ServerNotificationSourceSchema,
]);
export type NotificationSource = z.infer<typeof NotificationSourceSchema>;

/** Sources raised by a panel, in its worktree or in Home: navigable, with a tab dot. */
export type PanelNotificationSource = TerminalNotificationSource | BrowserNotificationSource;

export function isPanelSource(source: NotificationSource): source is PanelNotificationSource {
  return source.kind === "terminal" || source.kind === "browser";
}

export const ServerNotificationSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  source: NotificationSourceSchema,
  title: z.string().optional(),
  body: z.string().optional(),
  urgency: z.enum(["low", "normal", "high", "critical"]),
});
export type ServerNotification = z.infer<typeof ServerNotificationSchema>;
