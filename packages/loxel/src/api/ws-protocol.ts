import type { OpenTerminalRequest } from "@/open-request";

import type { RefInfo, StatusInfo, WorktreeStatusInfo } from "./git-models";
import type { LogEntry } from "./log-entry-model";
import type { ServerNotification } from "./notification-model";
import type { PanelOpenOptions } from "./panel-placement-model";
import type { DirEntry } from "./project-files-model";
import type { SchemaConsentState } from "./schema-consent-model";
import type { TerminalState } from "./terminal-stream";
import type { ToolchainChangedMessage } from "./toolchain-status-model";

/**
 * Who moved a file: Loxel (a file operation in any window) or another process. Only moves from
 * another process are announced to the user; Loxel's own are already visible where they happened.
 */
export type FileMoveSource = "loxel" | "external";

/** Server-to-client WebSocket message types (JSON text frames) */
export type WsMessage =
  // Worktree-scoped (sent to worktree subscribers only)
  | { type: "status_changed"; wtPath: string; data: StatusInfo }
  | { type: "files_dir_changed"; wtPath: string; data: { dir: string; entries: DirEntry[] } }
  | { type: "file_content_changed"; wtPath: string; data: { path: string; nonces: string[] } }
  /** A file an editor has open was renamed or moved (absolute paths). */
  | {
      type: "file_moved";
      wtPath: string;
      data: { oldPath: string; newPath: string; source: FileMoveSource };
    }
  | { type: "detached_files_changed"; wtPath: string; data: { entries: DirEntry[] } }
  | { type: "external_files_changed"; wtPath: string; data: { entries: DirEntry[] } }
  | { type: "worktree_files_resynced"; wtPath: string; projectPath: string }
  | ToolchainChangedMessage
  // Worktree-scoped, or for the window in use when no window shows the worktree. A null `wtPath`
  // (a link opened with Loxel as the browser) is for the window in use, in what it shows.
  | { type: "open_url"; wtPath: string | null; data: { url: string } & PanelOpenOptions }
  // Window-scoped (sent to the window the user is working in)
  | { type: "open_file"; data: OpenFilePanel }
  | { type: "open_folder"; data: { path: string } }
  | { type: "open_terminal"; data: OpenTerminalPanel }
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
  | ({ type: "terminal_state" } & TerminalState)
  | { type: "log_entries"; data: LogEntry[] }
  | { type: "log_error_count"; delta: number }
  | { type: "log_error_snapshot"; total: number }
  // Notifications (global)
  | { type: "notification_added"; data: ServerNotification }
  | { type: "notification_dismissed"; id: string }
  | { type: "notification_panel_dismissed"; panelId: string }
  | { type: "notifications_cleared" }
  | { type: "notifications_sync"; data: readonly ServerNotification[] }
  | { type: "store_updated"; key: string; state: Record<string, unknown>; nonce?: string }
  | { type: "schema_consent_changed"; data: SchemaConsentState }
  // Some repository's trust or restrictions changed (global, like the worktrees sharing it)
  | { type: "repo_trust_changed" };

/** Terminal notification sequences Loxel understands; see docs/TERMINALS.md#notifications. */
export const NOTIFICATION_SEQUENCES = ["osc9", "osc777", "osc99"] as const;
/** `osc9`: iTerm2 style; `osc777`: rxvt-unicode style; `osc99`: Kitty style. */
export type NotificationSequence = (typeof NOTIFICATION_SEQUENCES)[number];
export type NotificationSequences = Record<NotificationSequence, boolean>;
export const DEFAULT_NOTIFICATION_SEQUENCES: NotificationSequences = {
  osc9: true,
  osc777: true,
  osc99: true,
};

/**
 * A file the server asks a window to open (`loxel <file>`, Finder). It opens in `worktreePath` if
 * the command named one, else in the worktree holding it, else in the window's active worktree.
 */
export type OpenFilePanel = { filePath: string; worktreePath?: string } & PanelOpenOptions;

/**
 * A terminal panel the server asks a window to create (`loxel terminal`, the quickstart's command
 * field). The server has already minted `terminalId` and started its shell in `cwd`, with the
 * command typed in, so the renderer only places the panel in `worktreePath`, the worktree the
 * session belongs to, or in Home when it is null.
 */
export type OpenTerminalPanel = Omit<OpenTerminalRequest, "command"> & {
  terminalId: string;
  worktreePath: string | null;
} & PanelOpenOptions;

/** A terminal session and where its shell starts, as the panel sends it when attaching. */
export interface TerminalSpawnTarget {
  id: string;
  /** Directory the shell starts in. */
  cwd: string;
  /** The panel's worktree, exposed to the shell as `LOXEL_WORKTREE`; absent for a Home terminal. */
  worktreePath?: string;
  scrollbackLines?: number;
  /** The panel's window, exposed to the shell as `LOXEL_WINDOW_ID`. */
  windowId?: string;
  /** Activate the worktree's Python environment in the shell (`terminal.activatePythonEnv`); defaults to true. */
  activatePythonEnv?: boolean;
}

/** Client-to-server WebSocket message types (JSON text frames) */
export type WsClientMessage =
  | { type: "subscribe_worktree"; worktreePath: string }
  | { type: "unsubscribe_worktree"; worktreePath: string }
  | { type: "subscribe_logs" }
  | { type: "unsubscribe_logs" }
  | ({
      /**
       * Bind a mounted xterm to a terminal session, spawning the shell if the session does not
       * exist. The {@link TerminalSpawnTarget} fields apply only when spawning, except
       * `scrollbackLines`, which is applied on every attach like `cols` and `rows`.
       * `sinceEpoch`/`sinceOffset` identify the session and stream offset the client's xterm is
       * already current to (a reconnect with a live xterm); omit them for a fresh xterm.
       */
      type: "terminal_attach";
      cols: number;
      rows: number;
      sinceEpoch?: string;
      sinceOffset?: number;
    } & TerminalSpawnTarget)
  /** Stop streaming output to this client; the session keeps running. Sent on unmount. */
  | { type: "terminal_detach"; id: string }
  | { type: "terminal_resize"; id: string; cols: number; rows: number }
  | { type: "terminal_destroy"; id: string }
  /**
   * Flow control: the client has parsed `bytes` more bytes of output under the sync whose
   * `terminal_state` carried `syncOffset`; acks for an older sync are ignored.
   */
  | { type: "terminal_ack"; id: string; syncOffset: number; bytes: number }
  // External files
  | { type: "close_external_file"; worktreePath: string; filePath: string }
  | { type: "register_external_files"; worktreePath: string; filePaths: string[] }
  // Window identity and focus (target requests such as `loxel <folder>` at the window in use)
  | { type: "window_hello"; windowId: string }
  | { type: "window_focused" }
  // Notifications
  | { type: "notification_dismiss"; id: string }
  | { type: "notification_dismiss_panel"; panelId: string }
  | { type: "notifications_clear" };

// Close codes of a language-server socket, which tell the client whether to reconnect (see
// `lsp-connection.ts`).

/**
 * Another connection (another window) took over the worktree's server. Final: reconnecting would
 * take it back, and the other window would then do the same.
 */
export const LSP_REPLACED_CLOSE_CODE = 4000;
/** The server could not start (no binary, or it cannot be executed). Final until the user retries. */
export const LSP_START_FAILED_CLOSE_CODE = 4001;
/** Loxel restarts the server (a different binary was picked); the client reconnects at once. */
export const LSP_RESTART_CLOSE_CODE = 4002;
/**
 * The server process exited on its own (crash, out of memory, killed outside Loxel); the client
 * reconnects with backoff.
 */
export const LSP_EXITED_CLOSE_CODE = 4003;
