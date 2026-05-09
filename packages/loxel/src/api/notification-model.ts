/** Source identifies where a notification came from. Extensible for future sources. */
export type NotificationSource = { kind: "terminal"; panelId: string; worktreePath: string };
// Future additions:
// | { kind: "ci"; pipelineId: string; worktreePath?: string }
// | { kind: "agent"; agentId: string; worktreePath: string }

export interface ServerNotification {
  id: string;
  timestamp: number;
  source: NotificationSource;
  title?: string;
  body?: string;
  urgency: "low" | "normal" | "high" | "critical";
}
