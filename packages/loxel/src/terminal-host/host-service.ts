/**
 * The terminal host process's side of the socket: serves an {@link InProcessTerminalHost} to one
 * server at a time and decides when the process is done. See docs/TERMINAL_HOST.md#lifetime.
 *
 * - A connection must start with `initialize`, which is always answered; the connection that sent
 *   it becomes the host's server, replacing any earlier one, and the sessions are detached so a
 *   state or output meant for the earlier server's clients never reaches the new one.
 * - Events go to the current server; answers go to the connection that asked.
 * - When the server leaves with `disconnect {sessions: "end"}`, or a `terminate`, every session
 *   ends. With `keep`, they keep running until a server comes back. When its connection closes
 *   without either, they get {@link TERMINAL_HOST_GRACE_MS} for a server to come back before they end.
 * - With no server and no sessions left, the host is done.
 */
import { type Server, type Socket, createServer } from "node:net";

import type { ChildLogger } from "@/api/log-entry-model";
import { BIN_HEADER_SIZE, BIN_MSG_INPUT, parseBinaryHeader } from "@/api/terminal-stream";

import type { InProcessTerminalHost } from "./in-process-terminal-host";
import type { HostLogMessage, InitializeResult, ServerMessage } from "./protocol";
import {
  InitializeSchema,
  ServerMessageSchema,
  TERMINAL_HOST_CAPABILITIES,
  TERMINAL_HOST_PROTOCOL,
} from "./protocol";
import { FrameReader, encodeFrame, encodeJsonFrame } from "./protocol-framing";
import type { TerminalHostEvent } from "./terminal-host";

/**
 * How long sessions outlive a server whose connection closed without a `disconnect` (a crash, a
 * dev restart), and how long a new host waits for its first server.
 */
export const TERMINAL_HOST_GRACE_MS = 10 * 60_000;

export interface TerminalHostServiceOptions {
  host: InProcessTerminalHost;
  hostBuildId: string;
  log: ChildLogger;
  /** Where the host's log lines are forwarded to the current server, or null without one. */
  setLogForward: (forward: ((message: HostLogMessage) => void) | null) => void;
  /** The host has nothing left to do; the process exits. */
  onDone: (reason: string) => void;
  graceMs?: number;
}

class Connection {
  readonly reader = new FrameReader();
  initialized = false;
  /** Closed by the host, or replaced by a newer server: its close is not the server leaving. */
  retired = false;

  constructor(readonly socket: Socket) {}

  get open(): boolean {
    return !this.socket.destroyed;
  }

  send(frame: Uint8Array): void {
    if (this.open && !this.retired) this.socket.write(frame);
  }

  sendJson(message: object): void {
    this.send(encodeJsonFrame(message));
  }
}

export class TerminalHostService {
  private readonly server: Server;
  private readonly host: InProcessTerminalHost;
  private readonly log: ChildLogger;
  private readonly graceMs: number;
  private current: Connection | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(private readonly options: TerminalHostServiceOptions) {
    this.host = options.host;
    this.log = options.log;
    this.graceMs = options.graceMs ?? TERMINAL_HOST_GRACE_MS;
    this.server = createServer((socket) => this.accept(socket));
    this.host.onEvent((event) => this.onHostEvent(event));
  }

  /** Listen on `socketPath`, and give the server that started the host time to connect. */
  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => {
        this.server.off("error", reject);
        this.server.on("error", (err) =>
          this.log.error("Terminal host socket failed", { error: err }),
        );
        this.startGrace("waiting for a server");
        resolve();
      });
    });
  }

  /** Stop accepting connections and close every one. */
  close(): void {
    this.clearGrace();
    this.server.close();
    if (this.current) this.retire(this.current);
  }

  private accept(socket: Socket): void {
    const connection = new Connection(socket);
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.on("error", (err) => {
      this.log.warn("Terminal host connection failed", { error: err });
    });
    socket.on("close", () => this.onClose(connection));
  }

  private receive(connection: Connection, chunk: Buffer): void {
    let bodies;
    try {
      bodies = connection.reader.push(chunk);
    } catch (err) {
      this.log.error("Unreadable data from the server, closing its connection", { error: err });
      connection.socket.destroy();
      return;
    }
    for (const body of bodies) {
      if (!connection.open) return;
      if (body.kind === "binary") this.onBinary(connection, body.bytes);
      else this.onJson(connection, body.value);
    }
  }

  private onBinary(connection: Connection, bytes: Uint8Array): void {
    if (!connection.initialized || bytes.byteLength < BIN_HEADER_SIZE) return;
    const { type, terminalId } = parseBinaryHeader(bytes);
    if (type !== BIN_MSG_INPUT) {
      this.log.warn(`Ignoring a binary frame of unknown type ${type} from the server`);
      return;
    }
    this.host.write(terminalId, bytes.subarray(BIN_HEADER_SIZE));
  }

  private onJson(connection: Connection, value: unknown): void {
    if (!connection.initialized) {
      const initialize = InitializeSchema.safeParse(value);
      if (!initialize.success) {
        this.log.warn("A connection spoke before initialize, closing it");
        connection.socket.destroy();
        return;
      }
      this.log.info(
        `Server ${initialize.data.build} connected (protocol ${initialize.data.protocol})`,
      );
      this.adopt(connection);
      const result: InitializeResult = {
        type: "initialize_result",
        protocol: TERMINAL_HOST_PROTOCOL,
        hostBuildId: this.options.hostBuildId,
        pid: process.pid,
        capabilities: [...TERMINAL_HOST_CAPABILITIES],
      };
      connection.sendJson(result);
      return;
    }
    const parsed = ServerMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.log.warn("Ignoring a message the host does not understand", { error: parsed.error });
      const requestId = requestIdOf(value);
      if (requestId !== null) {
        connection.sendJson({ type: "error", requestId, message: "Unsupported request" });
      }
      return;
    }
    this.handle(connection, parsed.data);
  }

  private handle(connection: Connection, message: ServerMessage): void {
    switch (message.type) {
      case "initialize":
        this.log.warn("Ignoring a second initialize on one connection");
        return;
      case "disconnect": {
        this.log.info(`Server left, ${message.sessions === "end" ? "ending" : "keeping"} sessions`);
        if (message.sessions === "end") this.destroyAll();
        this.retire(connection);
        this.afterServerLeft(message.sessions);
        return;
      }
      case "terminate":
        this.log.info("Terminated by the server");
        this.destroyAll();
        this.retire(connection);
        this.finish("terminated");
        return;
      case "spawn": {
        const { requestId, request } = message;
        this.answer(connection, requestId, this.host.spawn(request));
        return;
      }
      case "list":
        this.answer(connection, message.requestId, this.host.list());
        return;
      case "attach":
        this.answer(
          connection,
          message.requestId,
          this.host.attach(message.request).then(() => null),
        );
        return;
      case "detach":
        this.host.detach(message.id);
        return;
      case "resize":
        this.host.resize(message.id, message.cols, message.rows);
        return;
      case "set_scrollback":
        this.host.setScrollback(message.id, message.lines);
        return;
      case "ack":
        this.host.ack(message.id, message.syncOffset, message.bytes);
        return;
      case "destroy":
        this.host.destroy(message.id);
        return;
      case "set_meta":
        this.host.setMeta(message.id, message.meta);
        return;
      default: {
        const unknown: never = message;
        throw new Error(`Unhandled server message ${JSON.stringify(unknown)}`);
      }
    }
  }

  private answer(connection: Connection, requestId: number, result: Promise<unknown>): void {
    result.then(
      (value) => connection.sendJson({ type: "result", requestId, value }),
      (err: unknown) => {
        const cause =
          err instanceof Error && err.cause !== undefined ? String(err.cause) : undefined;
        const message = err instanceof Error ? err.message : String(err);
        connection.sendJson({ type: "error", requestId, message, cause });
      },
    );
  }

  /** Make `connection` the host's server. */
  private adopt(connection: Connection): void {
    connection.initialized = true;
    this.clearGrace();
    const previous = this.current;
    this.current = connection;
    if (previous) {
      this.log.warn("A new server took over the terminal host from the connected one");
      this.retire(previous);
    }
    // Whatever the earlier server's clients were attached to, the new server attaches afresh.
    for (const id of this.host.sessionIds()) this.host.detach(id);
    this.options.setLogForward((message) => connection.sendJson(message));
  }

  /** Close the host's side of `connection`; it is no longer the server, if it was. */
  private retire(connection: Connection): void {
    connection.retired = true;
    if (this.current === connection) {
      this.current = null;
      this.options.setLogForward(null);
      for (const id of this.host.sessionIds()) this.host.detach(id);
    }
    connection.socket.end();
  }

  private onClose(connection: Connection): void {
    if (connection.retired || this.current !== connection) return;
    this.current = null;
    this.options.setLogForward(null);
    for (const id of this.host.sessionIds()) this.host.detach(id);
    this.log.warn("The server's connection closed without a disconnect");
    this.afterServerLeft("dropped");
  }

  private afterServerLeft(mode: "end" | "keep" | "dropped"): void {
    const sessions = this.host.sessionIds().length;
    if (sessions === 0) {
      this.finish("no sessions left");
      return;
    }
    if (mode === "dropped") this.startGrace(`${sessions} session(s) waiting for a server`);
  }

  private startGrace(reason: string): void {
    this.clearGrace();
    this.log.info(`Grace period of ${this.graceMs / 1000}s started: ${reason}`);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      const sessions = this.host.sessionIds().length;
      if (sessions > 0) this.log.info(`No server came back, ending ${sessions} session(s)`);
      this.destroyAll();
      this.finish("grace period ended");
    }, this.graceMs);
  }

  private clearGrace(): void {
    if (!this.graceTimer) return;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private destroyAll(): void {
    for (const id of this.host.sessionIds()) this.host.destroy(id);
  }

  private onHostEvent(event: TerminalHostEvent): void {
    const connection = this.current;
    if (connection) {
      if (event.type === "output") connection.send(encodeFrame(event.frame));
      else connection.sendJson(event);
      return;
    }
    // A session that ends while no server is connected may have been the last one.
    if (event.type === "exit" && this.host.sessionIds().length === 0) {
      this.finish("no sessions left");
    }
  }

  private finish(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.clearGrace();
    this.log.info(`Terminal host done: ${reason}`);
    this.options.onDone(reason);
  }
}

function requestIdOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return null;
  return typeof value.requestId === "number" ? value.requestId : null;
}
