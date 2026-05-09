import type { WsMessage } from "@/api/ws-protocol";

/** Build a `worktrees_changed` message for the given project. */
export function worktreesChangedMessage(projectPath: string): WsMessage {
  return { type: "worktrees_changed", data: { projectPath } };
}
