import type { SessionConfig } from "@bizimind/coding-agent";

import type { RefInfo, StatusInfo, WorktreeStatusInfo } from "./git-models";
import type { LogEntry } from "./log-entry-model";
import type { ServerNotification, NotificationSource } from "./notification-model";
import type { DirEntry } from "./project-files-model";
import type { UpdateState } from "./update-model";

export type AgentStatus = "starting" | "ready" | "running" | "waiting" | "exited";

/** Options for creating a new coding-agent session, derived from SessionConfig. */
export type AgentSessionOptions = Pick<
  SessionConfig,
  "models" | "mode" | "profile" | "declaredTools"
>;

/** Derive agent session status from a protocol event type. Returns undefined if no status change. */
export function deriveAgentStatus(eventType: string): AgentStatus | undefined {
  switch (eventType) {
    case "session.started":
    case "session.resumed":
    case "session.rewound":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "plan.mode.entered":
    case "plan.mode.exited":
      return "ready";
    case "run.started":
    case "human.input.response":
    case "approval.granted":
    case "approval.denied":
      return "running";
    case "human.input.requested":
    case "approval.requested":
      return "waiting";
    default:
      return undefined;
  }
}

/** Minimal protocol event shape forwarded from the coding-agent subprocess. */
export interface AgentEventPayload {
  type: string;
  session_id: string;
  run_id?: string;
  request_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/** Server-to-client WebSocket message types (JSON text frames) */
export type WsMessage =
  // Worktree-scoped (sent to worktree subscribers only)
  | { type: "status_changed"; wtPath: string; data: StatusInfo }
  | { type: "files_dir_changed"; wtPath: string; data: { dir: string; entries: DirEntry[] } }
  | { type: "file_content_changed"; wtPath: string; data: { path: string; nonces: string[] } }
  | { type: "detached_files_changed"; wtPath: string; data: { entries: DirEntry[] } }
  | { type: "external_files_changed"; wtPath: string; data: { entries: DirEntry[] } }
  | { type: "open_file"; wtPath: string; data: { filePath: string } }
  | { type: "open_url"; wtPath: string; data: { url: string } }
  // Project-scoped (sent to all subscribers under project)
  | { type: "refs_changed"; projectPath: string; data: RefInfo[] }
  | { type: "log_changed"; projectPath: string }
  | { type: "worktree_status_changed"; projectPath: string; data: WorktreeStatusInfo[] }
  | { type: "worktrees_changed"; data: { projectPath: string } }
  | {
      type: "localdb_changed";
      projectPath: string;
      data: { tableName?: string; tableId?: number; scope: "schema" | "data" | "views" };
    }
  // Global (sent to all clients)
  | { type: "error"; message: string }
  | { type: "terminal_exit"; id: string; exitCode: number }
  | { type: "agent_event"; id: string; seq: number; event: AgentEventPayload }
  | { type: "agent_exit"; id: string; exitCode: number }
  | {
      type: "agent_sessions";
      scopeKey: string;
      sessions: Array<{ id: string; status: string; codingAgentSessionId: string | null }>;
    }
  | { type: "agent_replay_done"; id: string }
  | { type: "agent_error"; id: string; message: string }
  | { type: "log_entries"; data: LogEntry[] }
  | { type: "log_error_count"; delta: number }
  | { type: "log_error_snapshot"; total: number }
  | { type: "update_status_changed"; data: UpdateState }
  // Notifications (global)
  | { type: "notification_added"; data: ServerNotification }
  | { type: "notification_dismissed"; id: string }
  | { type: "notification_panel_dismissed"; panelId: string }
  | { type: "notifications_cleared" }
  | { type: "notifications_sync"; data: readonly ServerNotification[] }
  | { type: "store_updated"; key: string; state: Record<string, unknown>; nonce?: string };

/** Default number of scrollback lines. Shared by client settings and server fallback. */
export const DEFAULT_SCROLLBACK_LINES = 50_000;

/** Client-to-server WebSocket message types (JSON text frames) */
export type WsClientMessage =
  | { type: "subscribe_worktree"; worktreePath: string }
  | { type: "unsubscribe_worktree"; worktreePath: string }
  | { type: "subscribe_logs" }
  | { type: "unsubscribe_logs" }
  | {
      type: "terminal_create";
      id: string;
      cols: number;
      rows: number;
      cwd: string;
      scrollbackLines?: number;
      windowId?: string;
    }
  | { type: "terminal_resize"; id: string; cols: number; rows: number }
  | { type: "terminal_destroy"; id: string }
  | {
      type: "agent_create";
      id: string;
      scopeKey: string;
      workspaceRoot: string;
      sessionOptions?: AgentSessionOptions;
      /** If set, resume this existing forked coding-agent session instead of starting a new one. */
      forkedSessionId?: string;
      /** If set with forkedSessionId, rewind to this message (the fork point). */
      forkPointMessageId?: string;
    }
  | { type: "agent_request"; id: string; request: Record<string, unknown> }
  | { type: "agent_destroy"; id: string }
  | { type: "agent_detach"; id: string }
  | { type: "agent_list"; scopeKey: string }
  // External files
  | { type: "close_external_file"; worktreePath: string; filePath: string }
  | { type: "register_external_files"; worktreePath: string; filePaths: string[] }
  // Notifications
  | {
      type: "notification_add";
      source: NotificationSource;
      title?: string;
      body?: string;
      urgency?: ServerNotification["urgency"];
    }
  | { type: "notification_dismiss"; id: string }
  | { type: "notification_dismiss_panel"; panelId: string }
  | { type: "notifications_clear" };

/**
 * Binary WebSocket frame protocol for terminal I/O.
 * Used for high-frequency data to avoid JSON overhead and preserve raw bytes.
 *
 * Frame format: [type: 1 byte][terminalId: 36 bytes ASCII UUID][payload: rest]
 *
 * Types:
 *   0x01 = terminal output (server → client) — payload is raw PTY bytes
 *   0x02 = terminal input  (client → server) — payload is UTF-8 input
 */
export const BIN_MSG_OUTPUT = 0x01;
export const BIN_MSG_INPUT = 0x02;
export const BIN_HEADER_SIZE = 1 + 36; // type byte + UUID

const textEncoder = new TextEncoder();

export function encodeBinaryFrame(
  type: number,
  terminalId: string,
  payload: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(BIN_HEADER_SIZE + payload.byteLength);
  buf[0] = type;
  buf.set(textEncoder.encode(terminalId), 1);
  buf.set(payload, BIN_HEADER_SIZE);
  return buf;
}

export function parseBinaryHeader(data: Uint8Array): { type: number; terminalId: string } {
  // index access on Uint8Array is safe after length check by caller
  const type = data[0]!;
  const terminalId = String.fromCharCode(...data.subarray(1, BIN_HEADER_SIZE));
  return { type, terminalId };
}
