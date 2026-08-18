import type { ChannelId, ClientId, ErrorCode, PeerInfo } from "./protocol.ts";

// ============================================================================
// Client Configuration
// ============================================================================

export interface ChannelClientOptions {
  /** Worker URL (e.g., "wss://channels.example.workers.dev") */
  url: string;

  /** Channel ID to join */
  channelId: ChannelId;

  /** Authentication token (JWT) */
  token: string;

  /** Optional client metadata to share with peers */
  meta?: Record<string, unknown>;

  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;

  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;

  /** Base delay for exponential backoff in ms (default: 1000) */
  reconnectBaseDelay?: number;

  /** Max delay for exponential backoff in ms (default: 30000) */
  reconnectMaxDelay?: number;

  /** Ping interval in ms (default: 30000) */
  pingInterval?: number;

  /** Connection timeout in ms (default: 10000) */
  connectionTimeout?: number;

  // Reliability options

  /** Enable ACK tracking for message delivery confirmation (default: true) */
  enableAck?: boolean;

  /** Timeout in ms to wait for ACK before retry (default: 5000) */
  ackTimeout?: number;

  /** Max retry attempts for unacknowledged messages (default: 3) */
  maxRetries?: number;

  /** ACK check interval in ms (default: 1000) */
  ackCheckInterval?: number;

  /** High water mark for pending messages before backpressure (default: 100) */
  maxPendingMessages?: number;
}

export interface ResolvedChannelClientOptions {
  url: string;
  channelId: ChannelId;
  token: string;
  meta: Record<string, unknown>;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
  reconnectMaxDelay: number;
  pingInterval: number;
  connectionTimeout: number;
  enableAck: boolean;
  ackTimeout: number;
  maxRetries: number;
  ackCheckInterval: number;
  maxPendingMessages: number;
}

// ============================================================================
// Event Types
// ============================================================================

export interface ConnectedEvent {
  type: "connected";
  clientId: ClientId;
  channelId: ChannelId;
  peers: PeerInfo[];
}

export interface DisconnectedEvent {
  type: "disconnected";
  reason: "close" | "error" | "timeout";
  willReconnect: boolean;
}

export interface PeerJoinedEvent {
  type: "peer_joined";
  peer: PeerInfo;
}

export interface PeerLeftEvent {
  type: "peer_left";
  clientId: ClientId;
  reason: "leave" | "disconnect" | "timeout";
}

export interface MessageEvent {
  type: "message";
  from: ClientId;
  payload: unknown;
  binary: boolean;
}

export interface BroadcastEvent {
  type: "broadcast";
  from: ClientId;
  payload: unknown;
  binary: boolean;
}

export interface ErrorEvent {
  type: "error";
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

export interface AckEvent {
  type: "ack";
  seq: number;
}

export interface MessageFailedEvent {
  type: "message_failed";
  seq: number;
  to?: ClientId;
  payload: unknown;
  binary: boolean;
}

export interface BackpressureEvent {
  type: "backpressure";
  pendingCount: number;
  /** "pause" when threshold exceeded, "resume" when back below 80% */
  action: "pause" | "resume";
}

export type ChannelEvent =
  | ConnectedEvent
  | DisconnectedEvent
  | PeerJoinedEvent
  | PeerLeftEvent
  | MessageEvent
  | BroadcastEvent
  | ErrorEvent
  | AckEvent
  | MessageFailedEvent
  | BackpressureEvent;

// ============================================================================
// Event Handler Types
// ============================================================================

export type EventHandler<T extends ChannelEvent["type"]> = (
  event: Extract<ChannelEvent, { type: T }>,
) => void;

export type AnyEventHandler = (event: ChannelEvent) => void;

// ============================================================================
// Connection State
// ============================================================================

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
