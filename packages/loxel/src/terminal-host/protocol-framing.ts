/**
 * The terminal host protocol's framing, part of its frozen bootstrap layer: every message is a
 * frame of a 4-byte big-endian body length followed by the body. A body starting with `{` is a JSON
 * message; any other body is a binary terminal frame in the renderer's layout (terminal-stream.ts),
 * so output reaches the renderer without being re-encoded. See docs/TERMINAL_HOST.md#protocol.
 */

/** Bytes of the length prefix. */
const LENGTH_BYTES = 4;
/** The largest body a peer accepts; a larger length means the stream is corrupt. */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;
/** The first byte of a JSON body. */
const JSON_BODY_START = 0x7b;

/** One body: a parsed JSON value, or the bytes of a binary terminal frame. */
export type FrameBody = { kind: "json"; value: unknown } | { kind: "binary"; bytes: Uint8Array };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** `body` with its length prefix. */
export function encodeFrame(body: Uint8Array): Uint8Array {
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`Frame of ${body.byteLength} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`);
  }
  const frame = new Uint8Array(LENGTH_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, LENGTH_BYTES);
  return frame;
}

/** A JSON message as a frame. */
export function encodeJsonFrame(message: object): Uint8Array {
  return encodeFrame(textEncoder.encode(JSON.stringify(message)));
}

/**
 * Splits a byte stream into frame bodies. Throws on a length beyond {@link MAX_FRAME_BYTES} or a
 * JSON body that does not parse; the stream cannot be trusted after either. Chunks are kept as they
 * arrive and joined once per completed body, so a large body costs one copy, not one per chunk.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  /** The length of the body being read, once its prefix is in. */
  private bodyLength: number | null = null;

  /** Every body completed by `chunk`, in order. */
  push(chunk: Uint8Array): FrameBody[] {
    // Copied: the socket may reuse the chunk's memory once this returns.
    this.chunks.push(chunk.slice());
    this.buffered += chunk.byteLength;
    const bodies: FrameBody[] = [];
    for (;;) {
      if (this.bodyLength === null) {
        if (this.buffered < LENGTH_BYTES) break;
        const prefix = this.take(LENGTH_BYTES);
        const length = new DataView(prefix.buffer, prefix.byteOffset).getUint32(0);
        if (length > MAX_FRAME_BYTES) {
          throw new Error(`Frame length ${length} exceeds the ${MAX_FRAME_BYTES}-byte limit`);
        }
        this.bodyLength = length;
      }
      if (this.buffered < this.bodyLength) break;
      bodies.push(parseBody(this.take(this.bodyLength)));
      this.bodyLength = null;
    }
    return bodies;
  }

  /** The next `count` buffered bytes, removed from the buffer. */
  private take(count: number): Uint8Array {
    const first = this.chunks[0];
    if (first && first.byteLength >= count) {
      const taken = first.subarray(0, count);
      if (first.byteLength === count) this.chunks.shift();
      else this.chunks[0] = first.subarray(count);
      this.buffered -= count;
      return taken;
    }
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.chunks[0]!;
      const part = chunk.subarray(0, count - filled);
      out.set(part, filled);
      filled += part.byteLength;
      if (part.byteLength === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part.byteLength);
    }
    this.buffered -= count;
    return out;
  }
}

function parseBody(body: Uint8Array): FrameBody {
  if (body[0] !== JSON_BODY_START) return { kind: "binary", bytes: body };
  try {
    return { kind: "json", value: JSON.parse(textDecoder.decode(body)) };
  } catch (err) {
    throw new Error("Malformed JSON frame", { cause: err });
  }
}
