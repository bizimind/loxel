import { z } from "zod";

// ============================================================================
// Channel Identification
// ============================================================================

export type ChannelId = string;
export type ClientId = string;

// ============================================================================
// Peer Information
// ============================================================================

export interface PeerInfo {
  clientId: ClientId;
  meta?: Record<string, unknown>;
  joinedAt: number;
}

// ============================================================================
// Envelope Types
// ============================================================================

export const EnvelopeTypeSchema = z.enum([
  // Control messages (client <-> server)
  "join",
  "leave",
  "joined",
  "peer_joined",
  "peer_left",
  "error",
  "ping",
  "pong",
  "ack",
  // User messages (relayed between clients)
  "message",
  "broadcast",
]);

export type EnvelopeType = z.infer<typeof EnvelopeTypeSchema>;

// ============================================================================
// Error Codes
// ============================================================================

export type ErrorCode =
  | "invalid_message"
  | "channel_not_found"
  | "peer_not_found"
  | "rate_limited"
  | "auth_failed"
  | "internal_error";

// ============================================================================
// Control Message Payloads
// ============================================================================

export interface JoinPayload {
  channelId: ChannelId;
  token: string;
  meta?: Record<string, unknown>;
  /** Last received sequence number for resuming missed messages */
  lastSeq?: number;
}

export interface JoinedPayload {
  clientId: ClientId;
  channelId: ChannelId;
  peers: PeerInfo[];
}

export interface PeerJoinedPayload {
  clientId: ClientId;
  meta?: Record<string, unknown>;
}

export interface PeerLeftPayload {
  clientId: ClientId;
  reason: "leave" | "disconnect" | "timeout";
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

export interface PingPayload {
  echo?: string;
}

export interface PongPayload {
  echo?: string;
}

export interface AckPayload {
  /** The sequence number being acknowledged */
  seq: number;
}

// ============================================================================
// Control Envelopes
// ============================================================================

export interface JoinEnvelope {
  type: "join";
  ts: number;
  payload: JoinPayload;
}

export interface LeaveEnvelope {
  type: "leave";
  ts: number;
  payload: Record<string, never>;
}

export interface JoinedEnvelope {
  type: "joined";
  ts: number;
  payload: JoinedPayload;
}

export interface PeerJoinedEnvelope {
  type: "peer_joined";
  ts: number;
  payload: PeerJoinedPayload;
}

export interface PeerLeftEnvelope {
  type: "peer_left";
  ts: number;
  payload: PeerLeftPayload;
}

export interface ErrorEnvelope {
  type: "error";
  ts: number;
  payload: ErrorPayload;
}

export interface PingEnvelope {
  type: "ping";
  ts: number;
  payload: PingPayload;
}

export interface PongEnvelope {
  type: "pong";
  ts: number;
  payload: PongPayload;
}

export interface AckEnvelope {
  type: "ack";
  ts: number;
  payload: AckPayload;
}

// ============================================================================
// Data Envelopes (user messages)
// ============================================================================

export interface MessageEnvelope {
  type: "message";
  ts: number;
  seq?: number;
  from: ClientId;
  to: ClientId;
  payload: unknown;
}

export interface BroadcastEnvelope {
  type: "broadcast";
  ts: number;
  seq?: number;
  from: ClientId;
  payload: unknown;
}

// ============================================================================
// Client -> Server Envelopes
// ============================================================================

export interface ClientMessageEnvelope {
  type: "message";
  ts: number;
  seq?: number;
  to: ClientId;
  payload: unknown;
}

export interface ClientBroadcastEnvelope {
  type: "broadcast";
  ts: number;
  seq?: number;
  payload: unknown;
}

// ============================================================================
// Union Types
// ============================================================================

export type ControlEnvelope =
  | JoinEnvelope
  | LeaveEnvelope
  | JoinedEnvelope
  | PeerJoinedEnvelope
  | PeerLeftEnvelope
  | ErrorEnvelope
  | PingEnvelope
  | PongEnvelope
  | AckEnvelope;

export type DataEnvelope = MessageEnvelope | BroadcastEnvelope;

export type ServerEnvelope =
  | JoinedEnvelope
  | PeerJoinedEnvelope
  | PeerLeftEnvelope
  | ErrorEnvelope
  | PingEnvelope
  | AckEnvelope
  | MessageEnvelope
  | BroadcastEnvelope;

export type ClientEnvelope =
  | JoinEnvelope
  | LeaveEnvelope
  | PongEnvelope
  | ClientMessageEnvelope
  | ClientBroadcastEnvelope;

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

export const JoinPayloadSchema = z.object({
  channelId: z.string().min(1).max(128),
  token: z.string().min(1),
  meta: z.record(z.unknown()).optional(),
  lastSeq: z.number().int().nonnegative().optional(),
});

export const PeerInfoSchema = z.object({
  clientId: z.string(),
  meta: z.record(z.unknown()).optional(),
  joinedAt: z.number(),
});

export const JoinedPayloadSchema = z.object({
  clientId: z.string(),
  channelId: z.string(),
  peers: z.array(PeerInfoSchema),
});

export const PeerJoinedPayloadSchema = z.object({
  clientId: z.string(),
  meta: z.record(z.unknown()).optional(),
});

export const PeerLeftPayloadSchema = z.object({
  clientId: z.string(),
  reason: z.enum(["leave", "disconnect", "timeout"]),
});

export const ErrorPayloadSchema = z.object({
  code: z.enum([
    "invalid_message",
    "channel_not_found",
    "peer_not_found",
    "rate_limited",
    "auth_failed",
    "internal_error",
  ]),
  message: z.string(),
  fatal: z.boolean(),
});

export const BaseEnvelopeSchema = z.object({
  type: EnvelopeTypeSchema,
  ts: z.number(),
  seq: z.number().int().positive().optional(),
});

// ============================================================================
// Binary Frame Format
// ============================================================================

/**
 * Binary frame header size in bytes.
 *
 * Format:
 * - Byte 0: Flags (bit 0: binary payload, bit 1: broadcast)
 * - Bytes 1-4: Sequence number (uint32 big-endian)
 * - Bytes 5-20: From client ID (16 bytes, null-padded ASCII)
 * - Bytes 21-36: To client ID (16 bytes, null-padded ASCII, ignored for broadcast)
 * - Bytes 37+: Payload
 */
export const BINARY_HEADER_SIZE = 37;
export const CLIENT_ID_SIZE = 16;

const FLAG_BINARY = 0x01;
const FLAG_BROADCAST = 0x02;

export interface BinaryFrame {
  isBinary: boolean;
  isBroadcast: boolean;
  seq: number;
  from: ClientId;
  to?: ClientId;
  payload: ArrayBuffer;
}

/**
 * Encode a client ID to a fixed-size buffer (16 bytes, null-padded).
 */
function encodeClientId(id: string, buffer: Uint8Array, offset: number): void {
  const bytes = new TextEncoder().encode(id);
  const len = Math.min(bytes.length, CLIENT_ID_SIZE);
  buffer.set(bytes.subarray(0, len), offset);
  // Null-pad remaining bytes
  for (let i = len; i < CLIENT_ID_SIZE; i++) {
    buffer[offset + i] = 0;
  }
}

/**
 * Decode a client ID from a fixed-size buffer (16 bytes, null-padded).
 */
function decodeClientId(buffer: Uint8Array, offset: number): string {
  let end = offset;
  for (let i = offset; i < offset + CLIENT_ID_SIZE; i++) {
    if (buffer[i] === 0) break;
    end = i + 1;
  }
  return new TextDecoder().decode(buffer.subarray(offset, end));
}

/**
 * Encode a BinaryFrame to an ArrayBuffer.
 */
export function encodeBinaryFrame(frame: BinaryFrame): ArrayBuffer {
  const payloadBytes = new Uint8Array(frame.payload);
  const buffer = new ArrayBuffer(BINARY_HEADER_SIZE + payloadBytes.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Byte 0: Flags
  let flags = 0;
  if (frame.isBinary) flags |= FLAG_BINARY;
  if (frame.isBroadcast) flags |= FLAG_BROADCAST;
  view.setUint8(0, flags);

  // Bytes 1-4: Sequence number (uint32 BE)
  view.setUint32(1, frame.seq, false);

  // Bytes 5-20: From client ID
  encodeClientId(frame.from, bytes, 5);

  // Bytes 21-36: To client ID
  encodeClientId(frame.to ?? "", bytes, 21);

  // Bytes 37+: Payload
  bytes.set(payloadBytes, BINARY_HEADER_SIZE);

  return buffer;
}

/**
 * Decode an ArrayBuffer to a BinaryFrame.
 */
export function decodeBinaryFrame(buffer: ArrayBuffer): BinaryFrame {
  if (buffer.byteLength < BINARY_HEADER_SIZE) {
    throw new Error(`Binary frame too small: ${buffer.byteLength} < ${BINARY_HEADER_SIZE}`);
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Byte 0: Flags
  const flags = view.getUint8(0);
  const isBinary = (flags & FLAG_BINARY) !== 0;
  const isBroadcast = (flags & FLAG_BROADCAST) !== 0;

  // Bytes 1-4: Sequence number
  const seq = view.getUint32(1, false);

  // Bytes 5-20: From client ID
  const from = decodeClientId(bytes, 5);

  // Bytes 21-36: To client ID
  const toRaw = decodeClientId(bytes, 21);
  const to = toRaw.length > 0 ? toRaw : undefined;

  // Bytes 37+: Payload
  const payload = buffer.slice(BINARY_HEADER_SIZE);

  return { isBinary, isBroadcast, seq, from, to, payload };
}
