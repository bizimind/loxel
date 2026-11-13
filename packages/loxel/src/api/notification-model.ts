/** Source identifies where a notification came from. Extensible for future sources. */
/** Where a notification came from: a terminal panel, in its worktree, or in Home when null. */
export type NotificationSource = { kind: "terminal"; panelId: string; worktreePath: string | null };
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
