/**
 * The stream contract between the owner of a terminal session and a view of it: the state message
 * that brings an xterm in line with the session, and the binary frames carrying output and input.
 * Shared by the renderer and the server, and by the terminal host for `TerminalState`, so it
 * imports nothing. See docs/TERMINALS.md#websocket-protocol.
 */

/**
 * How a `terminal_state` message brings the client's xterm in line with the session.
 *
 * - `snapshot`: the serialized screen and scrollback of the session's emulator at `offset`.
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
