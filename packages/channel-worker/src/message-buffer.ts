import type { ClientId } from "../../channel/src/protocol.ts";

/**
 * Relayed data message retained for replay on reconnect (in-memory only).
 */
export interface BufferedMessage {
  seq: number;
  from: ClientId;
  to?: ClientId;
  /** JSON payload; `null` for binary messages */
  payload: unknown;
  ts: number;
  isBroadcast: boolean;
  /** Binary payload (set only for binary frames) */
  binaryPayload?: ArrayBuffer;
}

export interface MessageBufferLimits {
  /** Maximum number of retained messages */
  maxEntries: number;
  /** Maximum total payload bytes retained */
  maxBytes: number;
}

/**
 * Approximate payload size of a buffered message in bytes.
 */
function payloadBytes(message: BufferedMessage): number {
  if (message.binaryPayload) {
    return message.binaryPayload.byteLength;
  }
  return JSON.stringify(message.payload)?.length ?? 0;
}

/**
 * Per-client ring buffer of relayed messages, bounded by entry count and total payload bytes.
 *
 * Binary payloads are retained as-is, so without a byte budget a handful of large frames could
 * pin the Durable Object's memory; the oldest messages are evicted until both limits hold.
 */
export class MessageBuffer {
  private readonly messages: BufferedMessage[] = [];
  private totalBytes = 0;

  constructor(private readonly limits: MessageBufferLimits) {}

  get size(): number {
    return this.messages.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  push(message: BufferedMessage): void {
    this.messages.push(message);
    this.totalBytes += payloadBytes(message);

    while (
      this.messages.length > this.limits.maxEntries ||
      (this.totalBytes > this.limits.maxBytes && this.messages.length > 0)
    ) {
      const evicted = this.messages.shift();
      if (evicted) {
        this.totalBytes -= payloadBytes(evicted);
      }
    }
  }

  /** Messages with a sequence number above `lastSeq`, oldest first. */
  after(lastSeq: number): BufferedMessage[] {
    return this.messages.filter((message) => message.seq > lastSeq);
  }
}
