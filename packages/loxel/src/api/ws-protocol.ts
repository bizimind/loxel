import type { OpenTerminalRequest } from "@/open-request";

import type { RefInfo, StatusInfo, WorktreeStatusInfo } from "./git-models";
import type { LogEntry } from "./log-entry-model";
import type { ServerNotification } from "./notification-model";
import type { PanelOpenOptions } from "./panel-placement-model";
import type { DirEntry } from "./project-files-model";
import type { ToolchainChangedMessage } from "./toolchain-status-model";
import type { UpdateState } from "./update-model";

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
  | { type: "open_url"; wtPath: string; data: { url: string } & PanelOpenOptions }
  // Window-scoped (sent to the window the user is working in)
  | { type: "open_file"; data: { filePath: string } & PanelOpenOptions }
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
  | { type: "update_status_changed"; data: UpdateState }
  // Notifications (global)
  | { type: "notification_added"; data: ServerNotification }
  | { type: "notification_dismissed"; id: string }
  | { type: "notification_panel_dismissed"; panelId: string }
  | { type: "notifications_cleared" }
  | { type: "notifications_sync"; data: readonly ServerNotification[] }
  | { type: "store_updated"; key: string; state: Record<string, unknown>; nonce?: string }
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

/** Default number of scrollback lines. Shared by client settings and server fallback. */
export const DEFAULT_SCROLLBACK_LINES = 50_000;

/** Bounds for the scrollback setting, enforced on both sides. */
export const MIN_SCROLLBACK_LINES = 1_000;
export const MAX_SCROLLBACK_LINES = 100_000;

/**
 * Bounds for a terminal's size. The server-side emulator allocates its cell grid eagerly, so
 * sizes are clamped there as well as fitted on the client.
 */
export const MIN_TERMINAL_COLS = 2;
export const MAX_TERMINAL_COLS = 1_000;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 500;

function clampDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: clampDimension(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, 80),
    rows: clampDimension(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, 24),
  };
}

export function clampScrollbackLines(lines: number | undefined): number {
  return Math.max(
    MIN_SCROLLBACK_LINES,
    Math.min(MAX_SCROLLBACK_LINES, lines ?? DEFAULT_SCROLLBACK_LINES),
  );
}

/**
 * How a `terminal_state` message brings the client's xterm in line with the server's session.
 *
 * - `snapshot`: the serialized screen and scrollback of the server-side emulator at `offset`.
 *   The client resets its xterm and writes `snapshot`, then applies output frames from `offset`.
 * - `resume`: the client's xterm is already current up to `offset`; output frames continue
 *   from there with nothing to replay.
 */
export type TerminalStateMode = "snapshot" | "resume";

export interface TerminalState {
  id: string;
  /** Random per spawn. Offsets are only comparable within one epoch. */
  epoch: string;
  mode: TerminalStateMode;
  /** Stream offset the client's xterm is current to once this message is applied. */
  offset: number;
  /** Present only for `snapshot`. */
  snapshot?: string;
  cols: number;
  rows: number;
}

/**
 * A terminal panel the server asks a window to create (`loxel terminal`). The server has already
 * minted `terminalId` and started its shell in `cwd`, with the command typed in, so the renderer
 * only places the panel in `worktreePath`, the worktree the session belongs to.
 */
export type OpenTerminalPanel = Omit<OpenTerminalRequest, "command"> & {
  terminalId: string;
  worktreePath: string;
} & PanelOpenOptions;

/** A terminal session and where its shell starts, as the panel sends it when attaching. */
export interface TerminalSpawnTarget {
  id: string;
  /** Directory the shell starts in. */
  cwd: string;
  /** The panel's worktree, exposed to the shell as `LOXEL_WORKTREE`; defaults to `cwd`. */
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

/**
 * Binary WebSocket frame protocol for terminal I/O.
 * Used for high-frequency data to avoid JSON overhead and preserve raw bytes.
 *
 * Output (server → client): [0x01][terminalId: 36 ASCII bytes][offset: u64 BE][payload]
 *   `offset` is the position of the payload's first byte in the session's output stream,
 *   counted from spawn. The client tracks `offset + payload.length` as the offset it is current
 *   to and sends it back as `sinceOffset` when it re-attaches after a reconnect.
 * Input (client → server):  [0x02][terminalId: 36 ASCII bytes][payload]
 *   `payload` is UTF-8 keyboard input or a terminal reply, written to the PTY verbatim.
 */
export const BIN_MSG_OUTPUT = 0x01;
export const BIN_MSG_INPUT = 0x02;
export const BIN_HEADER_SIZE = 1 + 36; // type byte + UUID
const OFFSET_SIZE = 8;
export const BIN_OUTPUT_HEADER_SIZE = BIN_HEADER_SIZE + OFFSET_SIZE;

const textEncoder = new TextEncoder();

function writeHeader(buf: Uint8Array, type: number, terminalId: string): void {
  buf[0] = type;
  buf.set(textEncoder.encode(terminalId), 1);
}

export function encodeInputFrame(terminalId: string, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(BIN_HEADER_SIZE + payload.byteLength);
  writeHeader(buf, BIN_MSG_INPUT, terminalId);
  buf.set(payload, BIN_HEADER_SIZE);
  return buf;
}

export function encodeOutputFrame(
  terminalId: string,
  offset: number,
  payload: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(BIN_OUTPUT_HEADER_SIZE + payload.byteLength);
  writeHeader(buf, BIN_MSG_OUTPUT, terminalId);
  new DataView(buf.buffer, buf.byteOffset).setBigUint64(BIN_HEADER_SIZE, BigInt(offset));
  buf.set(payload, BIN_OUTPUT_HEADER_SIZE);
  return buf;
}

/** Parse the common header. The caller guarantees `data.byteLength >= BIN_HEADER_SIZE`. */
export function parseBinaryHeader(data: Uint8Array): { type: number; terminalId: string } {
  const type = data[0]!;
  const terminalId = String.fromCharCode(...data.subarray(1, BIN_HEADER_SIZE));
  return { type, terminalId };
}

/** Parse an output frame's offset and payload. Returns null if the frame is too short. */
export function parseOutputFrame(
  data: Uint8Array,
): { terminalId: string; offset: number; payload: Uint8Array } | null {
  if (data.byteLength < BIN_OUTPUT_HEADER_SIZE) return null;
  const { terminalId } = parseBinaryHeader(data);
  const offset = Number(new DataView(data.buffer, data.byteOffset).getBigUint64(BIN_HEADER_SIZE));
  return { terminalId, offset, payload: data.subarray(BIN_OUTPUT_HEADER_SIZE) };
}

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
