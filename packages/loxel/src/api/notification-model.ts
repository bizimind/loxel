/** Source identifies where a notification came from. Extensible for future sources. */
export type NotificationSource =
  // A terminal panel's, in its worktree, or in Home when `worktreePath` is null
  | { kind: "terminal"; panelId: string; worktreePath: string | null }
  /** The server itself, about the terminal hosts (terminals it had to end at startup). */
  | { kind: "terminal_host" };
// Future additions:
// | { kind: "ci"; pipelineId: string; worktreePath?: string }

export interface ServerNotification {
  id: string;
  timestamp: number;
  source: NotificationSource;
  title?: string;
  body?: string;
  urgency: "low" | "normal" | "high" | "critical";
}
