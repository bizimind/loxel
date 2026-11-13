/**
 * The server's end of one connection to a terminal host's socket, from the handshake on: frames in
 * and out, and the close. See docs/TERMINAL_HOST.md#protocol.
 */
import { type Socket, createConnection } from "node:net";

import type { InitializeMessage, InitializeResult } from "./protocol";
import { InitializeResultSchema } from "./protocol";
import type { FrameBody } from "./protocol-framing";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";

/** How long a host has to answer `initialize`. */
export const INITIALIZE_TIMEOUT_MS = 5000;

/** Could not connect, or the host did not answer the handshake. */
export class HostConnectError extends Error {
  /**
   * True when nothing listens on the socket (it is gone, or the connection was refused): the host
   * is not running. False when it may be, but did not answer.
   */
  readonly refused: boolean;

  constructor(message: string, options: { refused: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "HostConnectError";
    this.refused = options.refused;
  }
}

export interface HostConnectionHandlers {
  onBody: (body: FrameBody) => void;
  /** The connection is closed, by either side; `error` when it failed. */
  onClose: (error?: Error) => void;
}

export class HostConnection {
  private handlers: HostConnectionHandlers | null = null;
  /** Bodies and the close that arrived before `start()`. */
  private early: FrameBody[] = [];
  private closed: { error?: Error } | null = null;
  private error: Error | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly reader: FrameReader,
    readonly result: InitializeResult,
    initialBodies: FrameBody[],
  ) {
    this.early = initialBodies;
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (err) => {
      this.error = err;
    });
    socket.on("close", () => this.onClose());
  }

  /** Deliver bodies and the close from now on, starting with any that already arrived. */
  start(handlers: HostConnectionHandlers): void {
    this.handlers = handlers;
    for (const body of this.early.splice(0)) {
      if (this.handlers !== handlers) return;
      handlers.onBody(body);
    }
    if (this.closed) handlers.onClose(this.closed.error);
  }

  get open(): boolean {
    return !this.socket.destroyed && this.closed === null;
  }

  send(frame: Uint8Array): void {
    if (this.open) this.socket.write(frame);
  }

  /** Close after what was sent is flushed. */
  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    let bodies: FrameBody[];
    try {
      bodies = this.reader.push(chunk);
    } catch (err) {
      this.error = new Error("Unreadable data from the terminal host", { cause: err });
      this.socket.destroy();
      return;
    }
    for (const body of bodies) {
      if (this.handlers) this.handlers.onBody(body);
      else this.early.push(body);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = { error: this.error };
    this.handlers?.onClose(this.error);
  }
}

const REFUSED_CODES = new Set(["ECONNREFUSED", "ENOENT"]);

/** Connect to the host at `socketPath` and do the handshake. */
export function openHostConnection(
  socketPath: string,
  initialize: InitializeMessage,
  timeoutMs = INITIALIZE_TIMEOUT_MS,
): Promise<HostConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const reader = new FrameReader();
    let settled = false;
    const fail = (error: HostConnectError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new HostConnectError(`No answer from the terminal host at ${socketPath}`, {
          refused: false,
        }),
      );
    }, timeoutMs);

    socket.on("connect", () => socket.write(encodeJsonFrame(initialize)));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const refused = err.code !== undefined && REFUSED_CODES.has(err.code);
      fail(
        new HostConnectError(`Could not connect to the terminal host at ${socketPath}`, {
          refused,
          cause: err,
        }),
      );
    });
    socket.on("close", () => {
      fail(
        new HostConnectError(`The terminal host at ${socketPath} closed the connection`, {
          refused: false,
        }),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      let bodies: FrameBody[];
      try {
        bodies = reader.push(chunk);
      } catch (err) {
        fail(
          new HostConnectError("Unreadable handshake from the terminal host", {
            refused: false,
            cause: err,
          }),
        );
        return;
      }
      const [first, ...rest] = bodies;
      if (!first) return;
      const result = first.kind === "json" ? InitializeResultSchema.safeParse(first.value) : null;
      if (!result?.success) {
        fail(
          new HostConnectError("The terminal host did not answer initialize", {
            refused: false,
            cause: result?.error,
          }),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("close");
      resolve(new HostConnection(socket, reader, result.data, rest));
    });
  });
}
