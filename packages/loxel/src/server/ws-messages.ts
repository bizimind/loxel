import type { WsMessage } from "@/api/ws-protocol";

/**
 * Build a `worktrees_changed` message for the given project. Send it to every client
 * (`broadcastAll`): each window's sidebar lists every project, not only those it is subscribed to.
 */
export function worktreesChangedMessage(projectPath: string): WsMessage {
  return { type: "worktrees_changed", data: { projectPath } };
}
