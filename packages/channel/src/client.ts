import { Connection } from "./connection.ts";
import { ChannelError, InvalidStateError } from "./errors.ts";
import { getLogger } from "./logger.ts";
import type { BinaryFrame, ClientId, PeerInfo, ServerEnvelope } from "./protocol.ts";
import type {
  AnyEventHandler,
  ChannelClientOptions,
  ChannelEvent,
  ConnectedEvent,
  ConnectionState,
  EventHandler,
  ResolvedChannelClientOptions,
} from "./types.ts";

/**
 * Default options for ChannelClient.
 */
const DEFAULT_OPTIONS = {
  meta: {} as Record<string, unknown>,
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
  pingInterval: 30000,
  connectionTimeout: 10000,
  enableAck: true,
  ackTimeout: 5000,
  maxRetries: 3,
  ackCheckInterval: 1000,
  maxPendingMessages: 100,
};

/**
 * Pending message awaiting ACK.
 */
interface PendingMessage {
  seq: number;
  to?: ClientId;
  payload: unknown;
  binary: boolean;
  sentAt: number;
  retries: number;
}

/**
 * Client for connecting to a channel and communicating with peers.
 *
 * @example
 * ```typescript
 * const client = new ChannelClient({
 *   url: "wss://channels.example.workers.dev",
 *   channelId: "room-123",
 *   token: "eyJhbGciOiJIUzI1NiIs...",
 *   meta: { username: "alice" },
 * });
 *
 * client.on("peer_joined", (e) => console.log(e.peer));
 * client.on("message", (e) => console.log(e.from, e.payload));
 *
 * await client.connect();
 *
 * client.send(peerId, { text: "hello" });
 * client.broadcast({ text: "hi all" });
 *
 * client.disconnect();
 * ```
 */
export class ChannelClient {
  private readonly options: ResolvedChannelClientOptions;
  private connection: Connection | null = null;
  private eventHandlers = new Map<string, Set<(event: ChannelEvent) => void>>();

  private _clientId: ClientId | null = null;
  private _peers = new Map<ClientId, PeerInfo>();
  private _state: ConnectionState = "disconnected";

  private connectPromise: {
    resolve: (event: ConnectedEvent) => void;
    reject: (error: Error) => void;
  } | null = null;

  // Reliability tracking
  private nextSeq = 1;
  private lastReceivedSeq = 0;
  private pendingMessages = new Map<number, PendingMessage>();
  private ackCheckTimer: ReturnType<typeof setInterval> | null = null;
  private backpressureActive = false;

  constructor(options: ChannelClientOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ==========================================================================
  // Connection Lifecycle
  // ==========================================================================

  /**
   * Connect to the channel.
   * Resolves when successfully joined the channel.
   *
   * @throws {ChannelError} If already connected or connecting
   * @throws {AuthenticationError} If authentication fails
   * @throws {ConnectionTimeoutError} If connection times out
   */
  async connect(): Promise<ConnectedEvent> {
    if (this._state !== "disconnected") {
      throw new InvalidStateError("Already connected or connecting");
    }

    this._state = "connecting";

    return new Promise((resolve, reject) => {
      this.connectPromise = { resolve, reject };

      const wsUrl = this.buildWebSocketUrl();

      this.connection = new Connection({
        url: wsUrl,
        pingInterval: this.options.pingInterval,
        connectionTimeout: this.options.connectionTimeout,
        autoReconnect: this.options.autoReconnect,
        maxReconnectAttempts: this.options.maxReconnectAttempts,
        reconnectBaseDelay: this.options.reconnectBaseDelay,
        reconnectMaxDelay: this.options.reconnectMaxDelay,

        onOpen: () => {
          // Send join message with lastSeq for message resumption
          this.connection?.send({
            type: "join",
            ts: Date.now(),
            payload: {
              channelId: this.options.channelId,
              token: this.options.token,
              meta: this.options.meta,
              lastSeq: this.lastReceivedSeq > 0 ? this.lastReceivedSeq : undefined,
            },
          });
        },

        onMessage: (envelope) => {
          this.handleServerMessage(envelope);
        },

        onBinaryMessage: (frame) => {
          this.handleBinaryMessage(frame);
        },

        onClose: (reason, willReconnect) => {
          const wasConnected = this._state === "connected";
          this._state = "disconnected";
          this._clientId = null;
          this._peers.clear();

          // If we were still connecting, reject the promise
          if (this.connectPromise && !wasConnected) {
            this.connectPromise.reject(new ChannelError(`Connection failed: ${reason}`));
            this.connectPromise = null;
          }

          this.emit({ type: "disconnected", reason, willReconnect });
        },

        onError: (error) => {
          if (this._state === "connecting" && this.connectPromise) {
            this.connectPromise.reject(error);
            this.connectPromise = null;
          }
          this.emit({
            type: "error",
            code: "internal_error",
            message: error.message,
            fatal: false,
          });
        },
      });

      this.connection.connect();
    });
  }

  /**
   * Disconnect from the channel.
   */
  disconnect(): void {
    // Stop ACK timer
    this.stopAckCheckTimer();

    if (this.connection) {
      // Send leave message if connected
      if (this._state === "connected") {
        this.connection.send({ type: "leave", ts: Date.now(), payload: {} });
      }
      this.connection.close();
      this.connection = null;
    }

    this._state = "disconnected";
    this._clientId = null;
    this._peers.clear();
    this.pendingMessages.clear();
    this.connectPromise = null;
  }

  // ==========================================================================
  // Messaging
  // ==========================================================================

  /**
   * Send a JSON message to a specific peer.
   *
   * @param to The client ID of the recipient
   * @param payload The message payload (will be JSON serialized)
   * @returns The sequence number assigned to this message
   * @throws {InvalidStateError} If not connected
   */
  send(to: ClientId, payload: unknown): number {
    this.assertConnected();
    const seq = this.getNextSeq();
    this.connection!.send({ type: "message", ts: Date.now(), seq, to, payload });
    this.trackPendingMessage(seq, to, payload, false);
    return seq;
  }

  /**
   * Send a binary message to a specific peer.
   *
   * @param to The client ID of the recipient
   * @param data The binary data to send
   * @returns The sequence number assigned to this message
   * @throws {InvalidStateError} If not connected
   */
  sendBinary(to: ClientId, data: ArrayBuffer): number {
    this.assertConnected();
    const seq = this.getNextSeq();
    this.connection!.sendBinary({
      isBinary: true,
      isBroadcast: false,
      seq,
      from: this._clientId!,
      to,
      payload: data,
    });
    this.trackPendingMessage(seq, to, data, true);
    return seq;
  }

  /**
   * Broadcast a JSON message to all peers.
   *
   * @param payload The message payload (will be JSON serialized)
   * @returns The sequence number assigned to this message
   * @throws {InvalidStateError} If not connected
   */
  broadcast(payload: unknown): number {
    this.assertConnected();
    const seq = this.getNextSeq();
    this.connection!.send({ type: "broadcast", ts: Date.now(), seq, payload });
    this.trackPendingMessage(seq, undefined, payload, false);
    return seq;
  }

  /**
   * Broadcast binary data to all peers.
   *
   * @param data The binary data to send
   * @returns The sequence number assigned to this message
   * @throws {InvalidStateError} If not connected
   */
  broadcastBinary(data: ArrayBuffer): number {
    this.assertConnected();
    const seq = this.getNextSeq();
    this.connection!.sendBinary({
      isBinary: true,
      isBroadcast: true,
      seq,
      from: this._clientId!,
      payload: data,
    });
    this.trackPendingMessage(seq, undefined, data, true);
    return seq;
  }

  /**
   * Send binary data without ACK tracking (fire-and-forget).
   * Use for high-frequency streams where latency matters more than reliability.
   * Messages sent this way will NOT be retried and will NOT emit message_failed.
   *
   * @param to The client ID of the recipient
   * @param data The binary data to send
   * @throws {InvalidStateError} If not connected
   */
  sendBinaryUnreliable(to: ClientId, data: ArrayBuffer): void {
    this.assertConnected();
    this.connection!.sendBinary({
      isBinary: true,
      isBroadcast: false,
      seq: 0, // seq=0 means no ACK expected
      from: this._clientId!,
      to,
      payload: data,
    });
  }

  /**
   * Broadcast binary data without ACK tracking (fire-and-forget).
   * Use for high-frequency streams where latency matters more than reliability.
   * Messages sent this way will NOT be retried and will NOT emit message_failed.
   *
   * @param data The binary data to send
   * @throws {InvalidStateError} If not connected
   */
  broadcastBinaryUnreliable(data: ArrayBuffer): void {
    this.assertConnected();
    this.connection!.sendBinary({
      isBinary: true,
      isBroadcast: true,
      seq: 0, // seq=0 means no ACK expected
      from: this._clientId!,
      payload: data,
    });
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  /**
   * Subscribe to a specific event type.
   *
   * @param type The event type to subscribe to
   * @param handler The handler function
   * @returns An unsubscribe function
   */
  on<T extends ChannelEvent["type"]>(type: T, handler: EventHandler<T>): () => void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }
    // Safe: emit() dispatches by type key, so handler only receives matching events
    this.eventHandlers.get(type)!.add(handler as (event: ChannelEvent) => void);
    return () => this.off(type, handler);
  }

  /**
   * Subscribe to all events.
   *
   * @param handler The handler function
   * @returns An unsubscribe function
   */
  onAny(handler: AnyEventHandler): () => void {
    if (!this.eventHandlers.has("*")) {
      this.eventHandlers.set("*", new Set());
    }
    this.eventHandlers.get("*")!.add(handler);
    return () => this.eventHandlers.get("*")?.delete(handler);
  }

  /**
   * Unsubscribe from a specific event type.
   *
   * @param type The event type
   * @param handler The handler function to remove
   */
  off<T extends ChannelEvent["type"]>(type: T, handler: EventHandler<T>): void {
    this.eventHandlers.get(type)?.delete(handler as (event: ChannelEvent) => void);
  }

  // ==========================================================================
  // State Accessors
  // ==========================================================================

  /**
   * Get the client's ID (assigned by server after joining).
   * Returns null if not connected.
   */
  get clientId(): ClientId | null {
    return this._clientId;
  }

  /**
   * Get a read-only map of connected peers.
   */
  get peers(): ReadonlyMap<ClientId, PeerInfo> {
    return this._peers;
  }

  /**
   * Get the current connection state.
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Check if currently connected.
   */
  get isConnected(): boolean {
    return this._state === "connected";
  }

  /**
   * Check if backpressure is active (pending messages at or above threshold).
   * When true, consider slowing down message sending or using unreliable methods.
   */
  get isBackpressured(): boolean {
    return this.backpressureActive;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private buildWebSocketUrl(): string {
    const base = this.options.url.replace(/\/$/, "");
    return `${base}/channel/${encodeURIComponent(this.options.channelId)}`;
  }

  private handleServerMessage(envelope: ServerEnvelope): void {
    switch (envelope.type) {
      case "joined":
        this.handleJoined(envelope);
        break;

      case "peer_joined":
        this.handlePeerJoined(envelope);
        break;

      case "peer_left":
        this.handlePeerLeft(envelope);
        break;

      case "message":
        if (envelope.seq) {
          this.lastReceivedSeq = Math.max(this.lastReceivedSeq, envelope.seq);
        }
        this.emit({
          type: "message",
          from: envelope.from,
          payload: envelope.payload,
          binary: false,
        });
        break;

      case "broadcast":
        if (envelope.seq) {
          this.lastReceivedSeq = Math.max(this.lastReceivedSeq, envelope.seq);
        }
        this.emit({
          type: "broadcast",
          from: envelope.from,
          payload: envelope.payload,
          binary: false,
        });
        break;

      case "error":
        this.handleError(envelope);
        break;

      case "ping":
        // Respond with pong
        this.connection?.send({
          type: "pong",
          ts: Date.now(),
          payload: { echo: envelope.payload.echo },
        });
        break;

      case "ack":
        this.handleAck(envelope.payload.seq);
        break;

      default: {
        const _exhaustive: never = envelope;
        throw new Error(`Unknown server envelope type: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }

  private handleJoined(envelope: {
    payload: { clientId: ClientId; channelId: string; peers: PeerInfo[] };
  }): void {
    this._state = "connected";
    this._clientId = envelope.payload.clientId;

    // Populate peers map
    this._peers.clear();
    for (const peer of envelope.payload.peers) {
      this._peers.set(peer.clientId, peer);
    }

    // Reset pending message timestamps so they get retried immediately
    // This handles reconnection: messages that were pending ACK when we
    // disconnected will now be retried with the fresh connection
    const now = Date.now();
    for (const pending of this.pendingMessages.values()) {
      pending.sentAt = now;
    }

    const event: ConnectedEvent = {
      type: "connected",
      clientId: envelope.payload.clientId,
      channelId: envelope.payload.channelId,
      peers: envelope.payload.peers,
    };

    // Resolve connect promise
    if (this.connectPromise) {
      this.connectPromise.resolve(event);
      this.connectPromise = null;
    }

    this.emit(event);
  }

  private handlePeerJoined(envelope: {
    payload: { clientId: ClientId; meta?: Record<string, unknown> };
  }): void {
    const peer: PeerInfo = {
      clientId: envelope.payload.clientId,
      meta: envelope.payload.meta,
      joinedAt: Date.now(),
    };

    this._peers.set(peer.clientId, peer);
    this.emit({ type: "peer_joined", peer });
  }

  private handlePeerLeft(envelope: {
    payload: { clientId: ClientId; reason: "leave" | "disconnect" | "timeout" };
  }): void {
    this._peers.delete(envelope.payload.clientId);
    this.emit({
      type: "peer_left",
      clientId: envelope.payload.clientId,
      reason: envelope.payload.reason,
    });
  }

  private handleError(envelope: {
    payload: { code: string; message: string; fatal: boolean };
  }): void {
    const { code, message, fatal } = envelope.payload;

    // If fatal error during connection, reject the promise
    if (fatal && this.connectPromise) {
      this.connectPromise.reject(
        new ChannelError(message, code as ChannelEvent["type"] extends "error" ? never : never),
      );
      this.connectPromise = null;
    }

    this.emit({
      type: "error",
      code: code as
        | "invalid_message"
        | "channel_not_found"
        | "peer_not_found"
        | "rate_limited"
        | "auth_failed"
        | "internal_error",
      message,
      fatal,
    });
  }

  private handleBinaryMessage(frame: BinaryFrame): void {
    // Track received seq for resumption
    if (frame.seq > 0) {
      this.lastReceivedSeq = Math.max(this.lastReceivedSeq, frame.seq);
    }

    if (frame.isBroadcast) {
      this.emit({ type: "broadcast", from: frame.from, payload: frame.payload, binary: true });
    } else {
      this.emit({ type: "message", from: frame.from, payload: frame.payload, binary: true });
    }
  }

  private emit(event: ChannelEvent): void {
    const logger = getLogger();

    // Type-specific handlers
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          logger.error("Event handler error", { error: err, eventType: event.type });
        }
      }
    }

    // Wildcard handlers
    const wildcardHandlers = this.eventHandlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (err) {
          logger.error("Wildcard event handler error", { error: err, eventType: event.type });
        }
      }
    }
  }

  private assertConnected(): void {
    if (this._state !== "connected" || !this.connection) {
      throw new InvalidStateError("Not connected");
    }
  }

  // ==========================================================================
  // Reliability Methods
  // ==========================================================================

  private getNextSeq(): number {
    return this.nextSeq++;
  }

  private trackPendingMessage(
    seq: number,
    to: ClientId | undefined,
    payload: unknown,
    binary: boolean,
  ): void {
    if (!this.options.enableAck) return;

    this.pendingMessages.set(seq, { seq, to, payload, binary, sentAt: Date.now(), retries: 0 });

    // Check for backpressure (threshold exceeded)
    if (!this.backpressureActive && this.pendingMessages.size >= this.options.maxPendingMessages) {
      this.backpressureActive = true;
      this.emit({ type: "backpressure", pendingCount: this.pendingMessages.size, action: "pause" });
    }

    // Start ACK check timer if not running
    this.startAckCheckTimer();
  }

  private handleAck(seq: number): void {
    const pending = this.pendingMessages.get(seq);
    if (pending) {
      this.pendingMessages.delete(seq);
      this.emit({ type: "ack", seq });

      // Check for backpressure resume (at 80% of threshold)
      if (
        this.backpressureActive &&
        this.pendingMessages.size < this.options.maxPendingMessages * 0.8
      ) {
        this.backpressureActive = false;
        this.emit({
          type: "backpressure",
          pendingCount: this.pendingMessages.size,
          action: "resume",
        });
      }
    }
  }

  private startAckCheckTimer(): void {
    if (this.ackCheckTimer) return;

    this.ackCheckTimer = setInterval(() => {
      this.checkPendingMessages();
    }, this.options.ackCheckInterval);
  }

  private stopAckCheckTimer(): void {
    if (this.ackCheckTimer) {
      clearInterval(this.ackCheckTimer);
      this.ackCheckTimer = null;
    }
  }

  private checkPendingMessages(): void {
    if (!this.options.enableAck || !this.connection) return;

    const now = Date.now();
    for (const [seq, msg] of this.pendingMessages) {
      if (now - msg.sentAt > this.options.ackTimeout) {
        if (msg.retries < this.options.maxRetries) {
          // Retry
          msg.retries++;
          msg.sentAt = now;
          this.resendMessage(msg);
        } else {
          // Max retries reached, emit failure
          this.pendingMessages.delete(seq);
          this.emit({
            type: "message_failed",
            seq: msg.seq,
            to: msg.to,
            payload: msg.payload,
            binary: msg.binary,
          });
        }
      }
    }

    // Stop timer if no pending messages
    if (this.pendingMessages.size === 0) {
      this.stopAckCheckTimer();
    }
  }

  private resendMessage(msg: PendingMessage): void {
    if (!this.connection || this._state !== "connected") return;

    if (msg.binary) {
      this.connection.sendBinary({
        isBinary: true,
        isBroadcast: msg.to === undefined,
        seq: msg.seq,
        from: this._clientId!,
        to: msg.to,
        payload: msg.payload as ArrayBuffer,
      });
    } else if (msg.to) {
      this.connection.send({
        type: "message",
        ts: Date.now(),
        seq: msg.seq,
        to: msg.to,
        payload: msg.payload,
      });
    } else {
      this.connection.send({
        type: "broadcast",
        ts: Date.now(),
        seq: msg.seq,
        payload: msg.payload,
      });
    }
  }

  /**
   * Get the last received sequence number (for resumption on reconnect).
   */
  get lastSeq(): number {
    return this.lastReceivedSeq;
  }

  /**
   * Update the authentication token.
   * The new token will be used on the next connection/reconnection.
   *
   * @param token The new JWT token
   */
  setToken(token: string): void {
    (this.options as { token: string }).token = token;
  }
}
