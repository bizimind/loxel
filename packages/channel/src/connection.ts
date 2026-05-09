import { ExponentialBackoff } from "./backoff.ts";
import { ConnectionTimeoutError, MaxReconnectAttemptsError } from "./errors.ts";
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  type BinaryFrame,
  type ServerEnvelope,
} from "./protocol.ts";

/**
 * Configuration for the WebSocket connection.
 */
export interface ConnectionOptions {
  /** WebSocket URL to connect to */
  url: string;

  /** Ping interval in milliseconds */
  pingInterval: number;

  /** Connection timeout in milliseconds */
  connectionTimeout: number;

  /** Enable auto-reconnect */
  autoReconnect: boolean;

  /** Max reconnect attempts */
  maxReconnectAttempts: number;

  /** Base delay for reconnection backoff */
  reconnectBaseDelay: number;

  /** Max delay for reconnection backoff */
  reconnectMaxDelay: number;

  /** Called when WebSocket opens */
  onOpen: () => void;

  /** Called when a JSON message is received */
  onMessage: (envelope: ServerEnvelope) => void;

  /** Called when a binary message is received */
  onBinaryMessage: (frame: BinaryFrame) => void;

  /** Called when WebSocket closes */
  onClose: (reason: "close" | "error" | "timeout", willReconnect: boolean) => void;

  /** Called on error */
  onError: (error: Error) => void;
}

type ConnectionState = "disconnected" | "connecting" | "connected";

/**
 * Manages WebSocket connection with automatic reconnection.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private backoff: ExponentialBackoff;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(private readonly options: ConnectionOptions) {
    this.backoff = new ExponentialBackoff({
      baseDelay: options.reconnectBaseDelay,
      maxDelay: options.reconnectMaxDelay,
      maxAttempts: options.maxReconnectAttempts,
    });
  }

  /**
   * Connect to the WebSocket server.
   */
  connect(): void {
    if (this.state !== "disconnected") {
      return;
    }

    this.intentionalClose = false;
    this.state = "connecting";
    this.createWebSocket();
  }

  /**
   * Close the WebSocket connection.
   */
  close(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.state = "disconnected";
  }

  /**
   * Send a JSON message.
   */
  send(envelope: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  /**
   * Send a binary message.
   */
  sendBinary(frame: BinaryFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeBinaryFrame(frame));
    }
  }

  /**
   * Get the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  private createWebSocket(): void {
    try {
      this.ws = new WebSocket(this.options.url);
      this.ws.binaryType = "arraybuffer";
      this.setupEventHandlers();
      this.startConnectionTimeout();
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.clearConnectionTimeout();
      this.state = "connected";
      this.backoff.reset();
      this.startPingInterval();
      this.options.onOpen();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const envelope = JSON.parse(event.data) as ServerEnvelope;
          this.options.onMessage(envelope);
        } catch {
          // Ignore invalid JSON
        }
      } else if (event.data instanceof ArrayBuffer) {
        try {
          const frame = decodeBinaryFrame(event.data);
          this.options.onBinaryMessage(frame);
        } catch {
          // Ignore invalid binary frames
        }
      }
    };

    this.ws.onclose = (_event: CloseEvent) => {
      this.clearConnectionTimeout();
      this.stopPingInterval();

      const wasConnected = this.state === "connected";
      this.state = "disconnected";
      this.ws = null;

      if (this.intentionalClose) {
        this.options.onClose("close", false);
        return;
      }

      const willReconnect = this.options.autoReconnect && this.scheduleReconnect();
      this.options.onClose(wasConnected ? "close" : "error", willReconnect);
    };

    this.ws.onerror = () => {
      // The error event doesn't contain useful information
      // The close event will fire after this with more details
    };
  }

  private startConnectionTimeout(): void {
    this.connectionTimer = setTimeout(() => {
      if (this.state === "connecting" && this.ws) {
        this.ws.close();
        this.handleError(new ConnectionTimeoutError(this.options.connectionTimeout));
      }
    }, this.options.connectionTimeout);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping", ts: Date.now(), payload: {} });
    }, this.options.pingInterval);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): boolean {
    const delay = this.backoff.nextDelay();
    if (delay === null) {
      this.options.onError(new MaxReconnectAttemptsError(this.options.maxReconnectAttempts));
      return false;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) {
        this.state = "connecting";
        this.createWebSocket();
      }
    }, delay);

    return true;
  }

  private handleError(error: Error): void {
    this.options.onError(error);
  }

  private cleanup(): void {
    this.clearConnectionTimeout();
    this.stopPingInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "Client closed");
      }
      this.ws = null;
    }
  }
}
