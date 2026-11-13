/**
 * The terminal host: what owns terminal sessions (PTY, headless emulator, stream offsets, resume
 * ring, snapshots, flow control and OSC detection) and what the server asks of it. Everything that
 * crosses this interface is plain data, answered by a promise or reported as an event, so it can be
 * carried over a socket unchanged; the host never calls into the server and never reads server
 * settings. The data's zod schemas are the source of its types, and what the socket protocol
 * (protocol.ts) validates. See docs/TERMINAL_HOST.md.
 */
import { z } from "zod";

import type { TerminalState } from "@/api/terminal-stream";

/** A JSON value: what can be stored in a session's {@link TerminalSessionMeta}. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.json();

/**
 * Data the server attaches to a session and reads back with `list()`. The host stores it as given
 * and never looks inside, so server-side fields can change without changing the host.
 */
export const TerminalSessionMetaSchema = z.record(z.string(), JsonValueSchema);
export type TerminalSessionMeta = { readonly [key: string]: JsonValue };

/** The OSC sequences the host reports as `osc` events: 9 (iTerm2), 777 (rxvt-unicode), 99 (Kitty). */
export const OSC_NOTIFICATION_CODES = [9, 777, 99] as const;
export type OscNotificationCode = (typeof OSC_NOTIFICATION_CODES)[number];

/** A terminal ID: a 36-character UUID, as in the binary frames. */
const TerminalIdSchema = z.string().length(36);
const SizeSchema = z.number().int().nonnegative();

export const TerminalStateSchema = z.object({
  id: TerminalIdSchema,
  epoch: z.string(),
  mode: z.enum(["snapshot", "resume"]),
  offset: SizeSchema,
  snapshot: z.string().optional(),
  cols: SizeSchema,
  rows: SizeSchema,
}) satisfies z.ZodType<TerminalState>;

/** A spawn as it crosses the socket; {@link TerminalSpawnRequest} adds the typed-ahead bytes. */
export const TerminalSpawnSpecSchema = z.object({
  /** The terminal ID, a 36-character UUID, as in the binary frames. */
  id: TerminalIdSchema,
  /**
   * Chosen by the caller, unique per spawn (a random UUID). Known to the caller before any event
   * of the session can arrive, so it can tell them from events of an earlier spawn under the ID.
   */
  epoch: z.string(),
  /** The program and its arguments; the host adds nothing to it. */
  argv: z.array(z.string()).min(1).readonly(),
  cwd: z.string(),
  /** The program's whole environment; the host inherits nothing. */
  env: z.record(z.string(), z.string()).readonly(),
  cols: SizeSchema,
  rows: SizeSchema,
  scrollbackLines: SizeSchema,
  meta: TerminalSessionMetaSchema,
});

export type TerminalSpawnRequest = z.infer<typeof TerminalSpawnSpecSchema> & {
  /**
   * Bytes written to the PTY right after the spawn, before anything else: typed ahead, the PTY
   * queues them until the program reads its first line.
   */
  input?: Uint8Array;
};

export const TerminalSessionInfoSchema = z.object({
  id: TerminalIdSchema,
  /** The spawn's epoch; offsets and `since` points are only meaningful within one epoch. */
  epoch: z.string(),
  /** Output bytes produced so far: the stream offset the next output chunk starts at. */
  offset: SizeSchema,
  pid: z.number().int(),
  cols: SizeSchema,
  rows: SizeSchema,
  meta: TerminalSessionMetaSchema,
});
export type TerminalSessionInfo = z.infer<typeof TerminalSessionInfoSchema>;

/**
 * The program in the foreground of each session's terminal, by session ID: its name, or null when
 * the session's own program (the shell) is in the foreground, at its prompt. A session the host
 * cannot tell about is left out.
 */
export const ForegroundProcessesSchema = z.record(TerminalIdSchema, z.string().nullable());
export type ForegroundProcesses = z.infer<typeof ForegroundProcessesSchema>;

export const TerminalAttachRequestSchema = z.object({
  id: TerminalIdSchema,
  /**
   * Chosen by the caller and echoed on every `state` event this attach produces (its first sync
   * and any flow-control resync). The caller tells by it which client a state belongs to, and that
   * output following it is for that client. It only has to be unique among the attaches one caller
   * sends to one host: the host keeps only the latest attach per session and never compares
   * numbers, so a caller that starts over (a restarted server) may start its own sequence.
   */
  attachment: z.number().int(),
  /** The epoch and offset a client's xterm is already current to, to resume without a snapshot. */
  since: z.object({ epoch: z.string(), offset: SizeSchema }).optional(),
});
export type TerminalAttachRequest = z.infer<typeof TerminalAttachRequestSchema>;

/**
 * Brings the attached client in line: sent for every attach and every flow-control resync, before
 * any output at or past `state.offset`.
 */
export const TerminalStateEventSchema = z.object({
  type: z.literal("state"),
  attachment: z.number().int(),
  state: TerminalStateSchema,
});

/**
 * The program ended on its own, after any final resync of a paused client. The session is gone by
 * the time this is delivered. A session ended with `destroy()` sends no exit.
 */
export const TerminalExitEventSchema = z.object({
  type: z.literal("exit"),
  id: TerminalIdSchema,
  epoch: z.string(),
  exitCode: z.number().int(),
});

/**
 * A notification sequence the emulator parsed, with its raw payload (everything after `code;`),
 * whether or not a client is attached. Unfiltered: the server applies settings and parsing.
 */
export const TerminalOscEventSchema = z.object({
  type: z.literal("osc"),
  id: TerminalIdSchema,
  epoch: z.string(),
  code: z.literal(OSC_NOTIFICATION_CODES),
  data: z.string(),
});

/**
 * Output for the attached client, in offset order, only after that client's `state`. `frame` is
 * the renderer's binary output frame for it (`encodeOutputFrame`), and `data` is a view of the
 * frame's payload, not a copy: the frame is sent to the renderer as is, never re-encoded.
 */
export interface TerminalOutputEvent {
  type: "output";
  id: string;
  offset: number;
  data: Uint8Array;
  frame: Uint8Array;
}

export type TerminalHostEvent =
  | z.infer<typeof TerminalStateEventSchema>
  | TerminalOutputEvent
  | z.infer<typeof TerminalExitEventSchema>
  | z.infer<typeof TerminalOscEventSchema>;

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
  /**
   * Each session's foreground program. A host that cannot tell (one without the
   * `foregroundProcess` capability) leaves its sessions out, so the caller falls back to what it
   * knows without it.
   */
  foregroundProcesses(): Promise<ForegroundProcesses>;
  /** Receive every event from now on. Returns the unsubscribe function. */
  onEvent(listener: (event: TerminalHostEvent) => void): () => void;
}
