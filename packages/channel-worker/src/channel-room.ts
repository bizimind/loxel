import type { AppLogger } from "@bizimind/logger";

import { DurableObject } from "cloudflare:workers";

import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  JoinPayloadSchema,
  type ClientId,
  type ErrorCode,
  type PeerInfo,
} from "../../channel/src/protocol.ts";
import { validateJwt } from "./auth.ts";
import { createRequestLogger, getIssuer, getJwksUrl, type Env } from "./index.ts";

/**
 * Session state for a connected client.
 */
interface ClientSession {
  clientId: ClientId;
  channelId: string;
  /** User ID from JWT sub claim - all clients in a channel must have the same sub */
  userId: string;
  meta?: Record<string, unknown>;
  joinedAt: number;
  lastActivity: number;
}

/**
 * Rate limiter state using token bucket algorithm.
 */
interface RateLimiter {
  tokens: number;
  lastRefill: number;
}

/**
 * Buffered message for delivery on reconnect.
 */
interface BufferedMessage {
  seq: number;
  from: ClientId;
  to?: ClientId;
  payload: unknown;
  ts: number;
  isBroadcast: boolean;
  /** Whether this is a binary message */
  isBinary?: boolean;
  /** Base64-encoded binary payload (for DO storage compatibility) */
  binaryPayload?: string;
}

/**
 * Attachment stored on WebSocket for hibernation.
 */
interface WebSocketAttachment {
  clientId: ClientId;
  pendingJoin?: boolean;
  session?: ClientSession;
}

/**
 * ChannelRoom Durable Object for managing WebSocket connections.
 *
 * Channels are user-scoped: all clients in a channel must have the same
 * JWT sub claim. This allows a single user to communicate between their
 * different devices, but prevents different users from joining the same channel.
 */
export class ChannelRoom extends DurableObject<Env> {
  /** Logger instance for this Durable Object */
  private logger: AppLogger;

  /** Map of WebSocket -> ClientSession */
  private sessions = new Map<WebSocket, ClientSession>();

  /** Reverse lookup: clientId -> WebSocket */
  private clientSockets = new Map<ClientId, WebSocket>();

  /** Channel ID this room is for */
  private channelId: string | null = null;

  /** User ID (sub claim) for this channel - all clients must match */
  private channelUserId: string | null = null;

  // Reliability features

  /** Track last seen sequence number per client for duplicate detection */
  private lastSeenSeq = new Map<ClientId, number>();

  /** Rate limiters per client (token bucket) */
  private rateLimiters = new Map<ClientId, RateLimiter>();

  /** Message buffers per client for delivery on reconnect */
  private messageBuffers = new Map<ClientId, BufferedMessage[]>();

  // Configuration constants
  private readonly RATE_LIMIT = 100; // messages per second
  private readonly BUCKET_SIZE = 200; // burst allowance
  private readonly BUFFER_SIZE = 100; // last N messages per client

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Create logger instance for this DO
    this.logger = createRequestLogger(env);

    // Load persisted channel owner from storage (survives DO eviction)
    this.ctx.blockConcurrencyWhile(async () => {
      this.channelUserId = (await this.ctx.storage.get<string>("channelUserId")) ?? null;
    });

    // Restore sessions from hibernation
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
      if (attachment?.session) {
        this.sessions.set(ws, attachment.session);
        this.clientSockets.set(attachment.session.clientId, ws);
        if (!this.channelId) {
          this.channelId = attachment.session.channelId;
        }
        if (!this.channelUserId) {
          this.channelUserId = attachment.session.userId;
        }
      }
    }
  }

  /**
   * Handle incoming HTTP requests (WebSocket upgrades).
   */
  override async fetch(request: Request): Promise<Response> {
    // Extract channel ID from URL
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/channel\/([^/]+)$/);
    const channelId = match?.[1];

    if (!channelId) {
      return new Response("Invalid channel path", { status: 400 });
    }

    // Store channel ID
    this.channelId = channelId;

    // Handle WebSocket upgrade
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Generate unique client ID (first 16 chars of UUID)
    const clientId = crypto.randomUUID().slice(0, 16);

    // Accept with hibernation support
    this.ctx.acceptWebSocket(server);

    // Store pending session
    const attachment: WebSocketAttachment = { clientId, pendingJoin: true };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle WebSocket messages.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (!attachment) {
      ws.close(1008, "Invalid session");
      return;
    }

    if (typeof message === "string") {
      await this.handleJsonMessage(ws, attachment, message);
    } else {
      await this.handleBinaryMessage(ws, attachment, message);
    }

    // Update last activity if session exists
    if (attachment.session) {
      attachment.session.lastActivity = Date.now();
      ws.serializeAttachment(attachment);
    }
  }

  /**
   * Handle JSON control messages.
   */
  private async handleJsonMessage(
    ws: WebSocket,
    attachment: WebSocketAttachment,
    message: string,
  ): Promise<void> {
    let envelope: { type: string; payload?: unknown; to?: string; seq?: number };
    try {
      envelope = JSON.parse(message);
    } catch {
      this.sendError(ws, "invalid_message", "Invalid JSON", false);
      return;
    }

    // Apply rate limiting for data messages (not control messages)
    if (
      attachment.session &&
      (envelope.type === "message" || envelope.type === "broadcast") &&
      !this.checkRateLimit(attachment.session.clientId)
    ) {
      this.sendError(ws, "rate_limited", "Too many messages", false);
      return;
    }

    switch (envelope.type) {
      case "join":
        await this.handleJoin(ws, attachment, envelope.payload);
        break;

      case "leave":
        this.handleLeave(ws, attachment, "leave");
        break;

      case "message":
        this.handleUserMessage(ws, attachment, envelope);
        break;

      case "broadcast":
        this.handleBroadcast(ws, attachment, envelope);
        break;

      case "ping":
        // Client keeping connection alive, respond with pong
        this.send(ws, { type: "pong", ts: Date.now(), payload: {} });
        break;

      case "pong":
        // Client responding to our ping, connection is alive
        break;

      default:
        this.sendError(ws, "invalid_message", `Unknown message type: ${envelope.type}`, false);
    }
  }

  /**
   * Handle join request.
   */
  private async handleJoin(
    ws: WebSocket,
    attachment: WebSocketAttachment,
    payload: unknown,
  ): Promise<void> {
    if (!attachment.pendingJoin) {
      this.sendError(ws, "invalid_message", "Already joined", false);
      return;
    }

    // Validate payload
    const result = JoinPayloadSchema.safeParse(payload);
    if (!result.success) {
      this.logger.warn("Invalid join payload", {
        error: result.error.message,
        channelId: this.channelId,
      });
      this.sendError(ws, "invalid_message", "Invalid join payload", true);
      return;
    }

    const { channelId, token, meta, lastSeq } = result.data;

    // Verify channel matches
    if (channelId !== this.channelId) {
      this.logger.warn("Channel mismatch", { expected: this.channelId, got: channelId });
      this.sendError(ws, "channel_not_found", "Channel mismatch", true);
      return;
    }

    // Validate JWT
    const jwksUrl = getJwksUrl(this.env.WORKOS_CLIENT_ID);
    const issuer = getIssuer(this.env.WORKOS_CLIENT_ID);
    const validation = await validateJwt(token, jwksUrl, issuer, this.logger);
    if (!validation.valid) {
      this.sendError(ws, "auth_failed", validation.error ?? "Authentication failed", true);
      return;
    }

    // Extract user ID from sub claim (required by validateJwt)
    const userId = validation.claims!.sub;

    // Enforce same-user channels: all clients must have the same sub claim
    if (this.channelUserId === null) {
      // First user sets the channel owner - persist to survive DO eviction
      this.channelUserId = userId;
      await this.ctx.storage.put("channelUserId", userId);
    } else if (this.channelUserId !== userId) {
      // Different user trying to join - reject
      this.sendError(ws, "auth_failed", "Channel belongs to a different user", true);
      return;
    }

    // Create session
    const session: ClientSession = {
      clientId: attachment.clientId,
      channelId,
      userId,
      meta,
      joinedAt: Date.now(),
      lastActivity: Date.now(),
    };

    // Register session
    this.sessions.set(ws, session);
    this.clientSockets.set(session.clientId, ws);

    // Update attachment
    attachment.pendingJoin = false;
    attachment.session = session;
    ws.serializeAttachment(attachment);

    // Get current peers
    const peers: PeerInfo[] = [];
    for (const [otherWs, otherSession] of this.sessions) {
      if (otherWs !== ws) {
        peers.push({
          clientId: otherSession.clientId,
          meta: otherSession.meta,
          joinedAt: otherSession.joinedAt,
        });
      }
    }

    // Send joined confirmation
    this.send(ws, {
      type: "joined",
      ts: Date.now(),
      payload: { clientId: session.clientId, channelId, peers },
    });

    // Send buffered messages if client is reconnecting with lastSeq
    if (lastSeq !== undefined) {
      this.sendBufferedMessages(ws, session.clientId, lastSeq);
    }

    // Notify existing peers
    this.broadcastControl(
      {
        type: "peer_joined",
        ts: Date.now(),
        payload: { clientId: session.clientId, meta: session.meta },
      },
      ws,
    );
  }

  /**
   * Handle leave request or disconnection.
   */
  private handleLeave(
    ws: WebSocket,
    attachment: WebSocketAttachment,
    reason: "leave" | "disconnect" | "timeout",
  ): void {
    const session = attachment.session;
    if (!session || !this.sessions.has(ws)) {
      ws.close(1000, "Not joined");
      return;
    }

    // Remove from maps
    this.sessions.delete(ws);
    this.clientSockets.delete(session.clientId);

    // Clean up per-client state
    this.rateLimiters.delete(session.clientId);
    this.lastSeenSeq.delete(session.clientId);
    this.messageBuffers.delete(session.clientId);
    // Delete persisted buffer from DO storage
    this.ctx.storage.delete(`buffer:${session.clientId}`);

    // Notify remaining peers
    this.broadcastControl({
      type: "peer_left",
      ts: Date.now(),
      payload: { clientId: session.clientId, reason },
    });

    // Close connection
    ws.close(1000, "Client left");
  }

  /**
   * Handle targeted user message.
   */
  private handleUserMessage(
    ws: WebSocket,
    attachment: WebSocketAttachment,
    envelope: { to?: string; payload?: unknown; seq?: number },
  ): void {
    const session = attachment.session;
    if (!session || !this.sessions.has(ws)) {
      this.sendError(ws, "invalid_message", "Not joined", false);
      return;
    }

    if (!envelope.to) {
      this.sendError(ws, "invalid_message", "Missing 'to' field", false);
      return;
    }

    // Check for duplicate (already processed)
    if (envelope.seq && this.isDuplicate(session.clientId, envelope.seq)) {
      // Already processed, send ACK but don't relay
      this.sendAck(ws, envelope.seq);
      return;
    }

    const targetWs = this.clientSockets.get(envelope.to);
    if (!targetWs) {
      this.sendError(ws, "peer_not_found", `Peer not found: ${envelope.to}`, false);
      return;
    }

    const ts = Date.now();

    // Buffer message for recipient (for reconnect recovery)
    if (envelope.seq) {
      this.bufferMessage(envelope.to, {
        seq: envelope.seq,
        from: session.clientId,
        to: envelope.to,
        payload: envelope.payload,
        ts,
        isBroadcast: false,
      });
    }

    // Relay with sender info
    this.send(targetWs, {
      type: "message",
      ts,
      seq: envelope.seq,
      from: session.clientId,
      to: envelope.to,
      payload: envelope.payload,
    });

    // Send ACK to sender
    if (envelope.seq) {
      this.sendAck(ws, envelope.seq);
    }
  }

  /**
   * Handle broadcast message.
   */
  private handleBroadcast(
    ws: WebSocket,
    attachment: WebSocketAttachment,
    envelope: { payload?: unknown; seq?: number },
  ): void {
    const session = attachment.session;
    if (!session || !this.sessions.has(ws)) {
      this.sendError(ws, "invalid_message", "Not joined", false);
      return;
    }

    // Check for duplicate (already processed)
    if (envelope.seq && this.isDuplicate(session.clientId, envelope.seq)) {
      // Already processed, send ACK but don't relay
      this.sendAck(ws, envelope.seq);
      return;
    }

    const ts = Date.now();

    // Relay to all except sender
    const message = {
      type: "broadcast",
      ts,
      seq: envelope.seq,
      from: session.clientId,
      payload: envelope.payload,
    };

    for (const [otherWs, otherSession] of this.sessions) {
      if (otherWs !== ws) {
        // Buffer message for each recipient (for reconnect recovery)
        if (envelope.seq) {
          this.bufferMessage(otherSession.clientId, {
            seq: envelope.seq,
            from: session.clientId,
            payload: envelope.payload,
            ts,
            isBroadcast: true,
          });
        }
        this.send(otherWs, message);
      }
    }

    // Send ACK to sender
    if (envelope.seq) {
      this.sendAck(ws, envelope.seq);
    }
  }

  /**
   * Handle binary message.
   */
  private async handleBinaryMessage(
    ws: WebSocket,
    attachment: WebSocketAttachment,
    message: ArrayBuffer,
  ): Promise<void> {
    const session = attachment.session;
    if (!session || !this.sessions.has(ws)) {
      return;
    }

    // Apply rate limiting
    if (!this.checkRateLimit(session.clientId)) {
      this.sendError(ws, "rate_limited", "Too many messages", false);
      return;
    }

    try {
      // Decode binary frame header
      const frame = decodeBinaryFrame(message);

      // Check for duplicate (already processed)
      if (frame.seq > 0 && this.isDuplicate(session.clientId, frame.seq)) {
        // Already processed, send ACK but don't relay
        this.sendAck(ws, frame.seq);
        return;
      }

      // Inject actual sender ID (client cannot spoof)
      frame.from = session.clientId;
      const encoded = encodeBinaryFrame(frame);

      if (frame.isBroadcast) {
        // Send to all except sender
        for (const [otherWs, otherSession] of this.sessions) {
          if (otherWs !== ws) {
            // Buffer for each recipient (for reconnect recovery)
            if (frame.seq > 0) {
              this.bufferBinaryMessage(otherSession.clientId, frame);
            }
            this.sendRaw(otherWs, encoded);
          }
        }
      } else if (frame.to) {
        // Send to specific peer — check existence before buffering
        const targetWs = this.clientSockets.get(frame.to);
        if (targetWs) {
          if (frame.seq > 0) {
            this.bufferBinaryMessage(frame.to, frame);
          }
          this.sendRaw(targetWs, encoded);
        }
      }

      // Send ACK to sender (binary messages with seq)
      if (frame.seq > 0) {
        this.sendAck(ws, frame.seq);
      }
    } catch {
      // Invalid binary frame, ignore
    }
  }

  /**
   * Handle WebSocket close.
   */
  override async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (attachment?.session && this.sessions.has(ws)) {
      this.handleLeave(ws, attachment, wasClean ? "disconnect" : "timeout");
    }
    // Flush logs non-blocking
    this.ctx.waitUntil(this.logger.flush());
  }

  /**
   * Handle WebSocket error.
   */
  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (attachment?.session && this.sessions.has(ws)) {
      this.handleLeave(ws, attachment, "disconnect");
    }
    // Flush logs non-blocking
    this.ctx.waitUntil(this.logger.flush());
  }

  /**
   * Send a JSON message to a WebSocket.
   */
  private send(ws: WebSocket, envelope: object): void {
    try {
      ws.send(JSON.stringify(envelope));
    } catch {
      // Connection may have closed
    }
  }

  /**
   * Send raw binary data to a WebSocket.
   */
  private sendRaw(ws: WebSocket, data: ArrayBuffer): void {
    try {
      ws.send(data);
    } catch {
      // Connection may have closed
    }
  }

  /**
   * Broadcast a control message to all clients except one.
   */
  private broadcastControl(envelope: object, exclude?: WebSocket): void {
    const data = JSON.stringify(envelope);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try {
          ws.send(data);
        } catch {
          // Connection may have closed
        }
      }
    }
  }

  /**
   * Send an error message.
   */
  private sendError(ws: WebSocket, code: ErrorCode, message: string, fatal: boolean): void {
    this.send(ws, { type: "error", ts: Date.now(), payload: { code, message, fatal } });

    if (fatal) {
      ws.close(1008, message);
    }
  }

  // ==========================================================================
  // Reliability Methods
  // ==========================================================================

  /**
   * Send an ACK for a message sequence number.
   */
  private sendAck(ws: WebSocket, seq: number): void {
    this.send(ws, { type: "ack", ts: Date.now(), payload: { seq } });
  }

  /**
   * Check if a message is a duplicate (already processed).
   * Updates lastSeenSeq for the client if not a duplicate.
   *
   * Note: This assumes in-order message delivery (guaranteed by WebSocket).
   * If seq N arrives after seq N+1, it will be treated as duplicate.
   * This is intentional: WebSockets preserve order, so out-of-order
   * arrival indicates a retry of an already-processed message.
   */
  private isDuplicate(clientId: ClientId, seq: number): boolean {
    const last = this.lastSeenSeq.get(clientId) ?? 0;
    if (seq <= last) {
      return true;
    }
    this.lastSeenSeq.set(clientId, seq);
    return false;
  }

  /**
   * Check rate limit for a client using token bucket algorithm.
   * Returns true if request is allowed, false if rate limited.
   */
  private checkRateLimit(clientId: ClientId): boolean {
    const now = Date.now();
    let limiter = this.rateLimiters.get(clientId);

    if (!limiter) {
      limiter = { tokens: this.BUCKET_SIZE, lastRefill: now };
      this.rateLimiters.set(clientId, limiter);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - limiter.lastRefill) / 1000;
    limiter.tokens = Math.min(this.BUCKET_SIZE, limiter.tokens + elapsed * this.RATE_LIMIT);
    limiter.lastRefill = now;

    if (limiter.tokens < 1) {
      return false; // Rate limited
    }

    limiter.tokens -= 1;
    return true;
  }

  /**
   * Buffer a message for a client (in-memory only).
   *
   * NOTE: Reconnect message recovery is currently limited because reconnecting
   * clients receive a new server-generated clientId. Buffers keyed by the old
   * clientId become unreachable. A proper fix requires a stable client identity
   * (e.g., client-chosen session ID sent in the join message). For now, buffers
   * only help within a single connection lifetime (e.g., deduplication).
   */
  private bufferMessage(clientId: ClientId, message: BufferedMessage): void {
    let buffer = this.messageBuffers.get(clientId);
    if (!buffer) {
      buffer = [];
      this.messageBuffers.set(clientId, buffer);
    }

    buffer.push(message);

    // Ring buffer: remove oldest if exceeds size
    if (buffer.length > this.BUFFER_SIZE) {
      buffer.shift();
    }
  }

  /**
   * Buffer a binary message for a client (for delivery on reconnect).
   * Converts ArrayBuffer to base64 for JSON-compatible DO storage.
   */
  private bufferBinaryMessage(
    clientId: ClientId,
    frame: {
      seq: number;
      from: ClientId;
      to?: ClientId;
      payload: ArrayBuffer;
      isBroadcast: boolean;
    },
  ): void {
    // Convert ArrayBuffer to base64 for storage using chunked encoding
    // to avoid exceeding the JS engine's maximum call stack / argument limit
    const bytes = new Uint8Array(frame.payload);
    const CHUNK_SIZE = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    const base64 = btoa(binary);

    this.bufferMessage(clientId, {
      seq: frame.seq,
      from: frame.from,
      to: frame.to,
      payload: null,
      ts: Date.now(),
      isBroadcast: frame.isBroadcast,
      isBinary: true,
      binaryPayload: base64,
    });
  }

  /**
   * Send buffered messages to a reconnecting client.
   * Only sends messages with seq > lastSeq.
   *
   * NOTE: This currently has limited effectiveness because reconnecting clients
   * receive a new clientId, so the buffer lookup will find an empty buffer.
   * See bufferMessage() for details on the limitation.
   */
  private sendBufferedMessages(ws: WebSocket, clientId: ClientId, lastSeq: number): void {
    const buffer = this.messageBuffers.get(clientId) ?? [];

    for (const msg of buffer) {
      if (msg.seq > lastSeq) {
        if (msg.isBinary && msg.binaryPayload) {
          // Reconstruct binary frame from base64 and send
          const bytes = Uint8Array.from(atob(msg.binaryPayload), (c) => c.charCodeAt(0));
          const frame = encodeBinaryFrame({
            isBinary: true,
            isBroadcast: msg.isBroadcast,
            seq: msg.seq,
            from: msg.from,
            to: msg.to,
            payload: bytes.buffer,
          });
          this.sendRaw(ws, frame);
        } else if (msg.isBroadcast) {
          this.send(ws, {
            type: "broadcast",
            ts: msg.ts,
            seq: msg.seq,
            from: msg.from,
            payload: msg.payload,
          });
        } else {
          this.send(ws, {
            type: "message",
            ts: msg.ts,
            seq: msg.seq,
            from: msg.from,
            to: msg.to,
            payload: msg.payload,
          });
        }
      }
    }
  }
}
