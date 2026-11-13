/**
 * The terminal host: what owns terminal sessions (PTY, headless emulator, stream offsets, resume
 * ring, snapshots, flow control and OSC detection) and what the server asks of it. Everything that
 * crosses this interface is plain data, answered by a promise or reported as an event, so it can be
 * carried over a socket unchanged; the host never calls into the server and never reads server
 * settings. See docs/TERMINAL_HOST.md.
 */
import type { TerminalState } from "@/api/terminal-stream";

/** A JSON value: what can be stored in a session's {@link TerminalSessionMeta}. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Data the server attaches to a session and reads back with `list()`. The host stores it as given
 * and never looks inside, so server-side fields can change without changing the host.
 */
export type TerminalSessionMeta = { readonly [key: string]: JsonValue };

/** The OSC sequences the host reports as `osc` events: 9 (iTerm2), 777 (rxvt-unicode), 99 (Kitty). */
export const OSC_NOTIFICATION_CODES = [9, 777, 99] as const;
export type OscNotificationCode = (typeof OSC_NOTIFICATION_CODES)[number];

export interface TerminalSpawnRequest {
  /** The terminal ID, a 36-character UUID, as in the binary frames. */
  id: string;
  /**
   * Chosen by the caller, unique per spawn (a random UUID). Known to the caller before any event
   * of the session can arrive, so it can tell them from events of an earlier spawn under the ID.
   */
  epoch: string;
  /** The program and its arguments; the host adds nothing to it. */
  argv: readonly string[];
  cwd: string;
  /** The program's whole environment; the host inherits nothing. */
  env: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
  scrollbackLines: number;
  meta: TerminalSessionMeta;
  /**
   * Bytes written to the PTY right after the spawn, before anything else: typed ahead, the PTY
   * queues them until the program reads its first line.
   */
  input?: Uint8Array;
}

export interface TerminalSessionInfo {
  id: string;
  /** The spawn's epoch; offsets and `since` points are only meaningful within one epoch. */
  epoch: string;
  /** Output bytes produced so far: the stream offset the next output chunk starts at. */
  offset: number;
  pid: number;
  cols: number;
  rows: number;
  meta: TerminalSessionMeta;
}

export interface TerminalAttachRequest {
  id: string;
  /**
   * Chosen by the caller and echoed on every `state` event this attach produces (its first sync
   * and any flow-control resync). The caller tells by it which client a state belongs to, and that
   * output following it is for that client. It only has to be unique among the attaches one caller
   * sends to one host: the host keeps only the latest attach per session and never compares
   * numbers, so a caller that starts over (a restarted server) may start its own sequence.
   */
  attachment: number;
  /** The epoch and offset a client's xterm is already current to, to resume without a snapshot. */
  since?: { epoch: string; offset: number };
}

export type TerminalHostEvent =
  /**
   * Brings the attached client in line: sent for every attach and every flow-control resync,
   * before any output at or past `state.offset`.
   */
  | { type: "state"; attachment: number; state: TerminalState }
  /** Output for the attached client, in offset order, only after that client's `state`. */
  | { type: "output"; id: string; offset: number; data: Uint8Array }
  /**
   * The program ended on its own, after any final resync of a paused client. The session is gone
   * by the time this is delivered. A session ended with `destroy()` sends no exit.
   */
  | { type: "exit"; id: string; epoch: string; exitCode: number }
  /**
   * A notification sequence the emulator parsed, with its raw payload (everything after `code;`),
   * whether or not a client is attached. Unfiltered: the server applies settings and parsing.
   */
  | { type: "osc"; id: string; epoch: string; code: OscNotificationCode; data: string };

/**
 * Commands to the host. Each applies after every command sent before it, so a `write` sent right
 * after `spawn()` returns reaches the new program, possibly before the spawn has resolved; events
 * of the new session can likewise arrive before it resolves. Commands naming an unknown ID do
 * nothing.
 */
export interface TerminalHost {
  /** Start a session. Rejects if the ID is in use or the program cannot be started. */
  spawn(request: TerminalSpawnRequest): Promise<TerminalSessionInfo>;
  list(): Promise<TerminalSessionInfo[]>;
  /**
   * Bind the client: replaces any attached one. Resolves once the attach's `state` event has
   * been delivered, or once it was superseded by another attach, a detach or the session's end.
   */
  attach(request: TerminalAttachRequest): Promise<void>;
  /** Stop sending output. The program keeps running and its output keeps being parsed. */
  detach(id: string): void;
  /** Keyboard input or terminal replies, written to the PTY verbatim. */
  write(id: string, data: Uint8Array): void;
  /** Clamped to the terminal size bounds; a no-op when the size does not change. */
  resize(id: string, cols: number, rows: number): void;
  setScrollback(id: string, lines: number): void;
  /** Flow control: the attached client parsed `bytes` more bytes under the sync at `syncOffset`. */
  ack(id: string, syncOffset: number, bytes: number): void;
  /**
   * Hang up and kill the program. The session is gone at once. Part of the contract: a destroyed
   * session never sends `exit`, even when its program ends later, so the caller removes the
   * session itself when it asks for the destroy.
   */
  destroy(id: string): void;
  setMeta(id: string, meta: TerminalSessionMeta): void;
  /** Receive every event from now on. Returns the unsubscribe function. */
  onEvent(listener: (event: TerminalHostEvent) => void): () => void;
}
