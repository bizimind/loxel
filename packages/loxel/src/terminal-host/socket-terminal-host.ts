/**
 * A {@link TerminalHost} in a terminal host process, reached over its socket: the server's view of
 * one host. See docs/TERMINAL_HOST.md#the-servers-side.
 *
 * - Commands are framed and sent in call order. Until the connection is up (a host still starting)
 *   or while it is being restored, they wait in order, and requests are answered once it is.
 * - A connection that closes unasked does not mean the sessions are gone: the client reconnects,
 *   reconciles its sessions with the host's `list()` and re-sends the latest attach of every
 *   session that had a client, resuming from what that client last got. Only when the host is
 *   confirmed gone (its socket refuses connections, or its process is not running) are its
 *   sessions reported ended, with {@link HOST_LOST_EXIT_CODE}.
 */
import type { ChildLogger } from "@/api/log-entry-model";
import { encodeInputFrame, parseOutputFrame } from "@/api/terminal-stream";

import type { HostConnection } from "./host-connection";
import { HostConnectError, openHostConnection } from "./host-connection";
import { isProcessRunning } from "./host-files";
import type {
  DisconnectMode,
  HostMessage,
  InitializeMessage,
  InitializeResult,
  TerminalHostCapability,
} from "./protocol";
import { HostMessageSchema, RESULT_SCHEMAS, sharedCapabilities } from "./protocol";
import type { FrameBody } from "./protocol-framing";
import { encodeFrame, encodeJsonFrame } from "./protocol-framing";
import type {
  ForegroundProcesses,
  TerminalAttachRequest,
  TerminalHost,
  TerminalHostEvent,
  TerminalSessionInfo,
  TerminalSessionMeta,
  TerminalSpawnRequest,
} from "./terminal-host";

/**
 * The exit code reported for a session whose host is gone, or that ended while the server was not
 * connected: 128 + SIGHUP, what its shell got when the PTY closed. Not a code the program chose.
 */
export const HOST_LOST_EXIT_CODE = 129;

/** How long a host may be unreachable before new sessions stop going to it. */
export const STALLED_AFTER_MS = 30_000;

/** Delays between attempts to restore a connection to a host that is still running. */
const RECONNECT_DELAYS_MS = [0, 250, 1000, 5000];

interface PendingRequest {
  /** The request's frame, re-sent if it was not answered before a connection closed. */
  frame: Uint8Array;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  parse: (value: unknown) => unknown;
  /** For a spawn: the session it starts, so a restored connection can tell whether it did. */
  spawn?: { id: string; epoch: string };
  /** For an attach: answered as superseded if its connection closes. */
  attach?: boolean;
  /** Sent on a connection, rather than waiting in the outbox. */
  sent: boolean;
  /** The client's own request while restoring a connection; fails if that connection closes. */
  internal?: boolean;
}

/** What the client keeps about a session of this host. */
interface KnownSession {
  epoch: string;
  /** False while its spawn is unanswered. */
  confirmed: boolean;
  /**
   * The latest attach and the point its client is current to, until a detach. `sent` once it went
   * out on a connection: only such an attach is re-sent when a connection is restored.
   */
  attach: { attachment: number; sent: boolean; since?: { epoch: string; offset: number } } | null;
}

export interface SocketTerminalHostOptions {
  hostId: string;
  socketPath: string;
  /** What to send as `initialize` on every connection. */
  initialize: InitializeMessage;
  log: ChildLogger;
  /** Replaces the process check, for tests. */
  isProcessAlive?: (pid: number) => boolean;
  /** Replaces {@link openHostConnection} after the first connection, for tests. */
  connect?: typeof openHostConnection;
}

type State = "connecting" | "connected" | "reconnecting" | "gone";

export class SocketTerminalHost implements TerminalHost {
  readonly hostId: string;
  private state: State = "connecting";
  private connection: HostConnection | null = null;
  private hello: InitializeResult | null = null;
  /** What both this server and the host advertise, from the latest handshake. */
  private capabilities: ReadonlySet<TerminalHostCapability> = new Set();
  /** Frames sent while there is no connection, in order. */
  private outbox: Uint8Array[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, KnownSession>();
  private readonly listeners = new Set<(event: TerminalHostEvent) => void>();
  private readonly goneListeners = new Set<() => void>();
  private lastRequestId = 0;
  /** The connection a reconnect is opening, until it is open or failed. */
  private connectAttempt: Promise<HostConnection> | null = null;
  /** When the current run of reconnect attempts started, while there is one. */
  private reconnectingSince: number | null = null;
  private readonly log: ChildLogger;

  /**
   * `connection` is the host's first connection, already open (a host found running) or on its way
   * (a host being started); commands wait for it.
   */
  constructor(
    private readonly options: SocketTerminalHostOptions,
    connection: Promise<HostConnection>,
  ) {
    this.hostId = options.hostId;
    this.log = options.log.with({ hostId: options.hostId });
    connection.then(
      (opened) => this.onConnected(opened),
      (err: unknown) => this.markGone("its first connection failed", err),
    );
  }

  /** The host's handshake answer, once connected. */
  get initializeResult(): InitializeResult | null {
    return this.hello;
  }

  /**
   * Whether both this server and the host have `capability`, so its messages may be sent. False
   * until the first handshake. A capability's caller checks it and falls back without it, so a
   * host from before the capability, and one with capabilities this server does not know, both
   * keep working.
   */
  supports(capability: TerminalHostCapability): boolean {
    return this.capabilities.has(capability);
  }

  /** Sessions known to run in this host, spawns still unanswered included. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  get isGone(): boolean {
    return this.state === "gone";
  }

  /**
   * False once the host is gone, or has been unreachable for {@link STALLED_AFTER_MS} while its
   * process runs: new sessions then go to another host, and this one keeps its own.
   */
  get acceptsNewSessions(): boolean {
    if (this.state === "gone") return false;
    if (this.reconnectingSince === null) return true;
    return Date.now() - this.reconnectingSince < STALLED_AFTER_MS;
  }

  spawn(request: TerminalSpawnRequest): Promise<TerminalSessionInfo> {
    const { input, ...spec } = request;
    if (this.state === "gone") return Promise.reject(this.goneError());
    this.sessions.set(spec.id, { epoch: spec.epoch, confirmed: false, attach: null });
    const spawned = this.request<TerminalSessionInfo>(
      { type: "spawn", request: spec },
      (value) => RESULT_SCHEMAS.spawn.parse(value),
      { spawn: { id: spec.id, epoch: spec.epoch } },
    );
    // The input frame follows the spawn, so it is the first thing the program reads.
    if (input && input.byteLength > 0) this.send(encodeFrame(encodeInputFrame(spec.id, input)));
    return spawned.then(
      (info) => {
        const known = this.sessions.get(spec.id);
        if (known?.epoch === spec.epoch) known.confirmed = true;
        return info;
      },
      (err: unknown) => {
        if (this.sessions.get(spec.id)?.epoch === spec.epoch) this.sessions.delete(spec.id);
        throw err;
      },
    );
  }

  list(): Promise<TerminalSessionInfo[]> {
    if (this.state === "gone") return Promise.reject(this.goneError());
    return this.request({ type: "list" }, (value) =>
      this.noteListed(RESULT_SCHEMAS.list.parse(value)),
    );
  }

  /** Sessions a list reports are this host's from now on, for reconnects and for a lost host. */
  private noteListed(sessions: TerminalSessionInfo[]): TerminalSessionInfo[] {
    for (const { id, epoch } of sessions) {
      if (this.sessions.get(id)?.epoch !== epoch) {
        this.sessions.set(id, { epoch, confirmed: true, attach: null });
      }
    }
    return sessions;
  }

  attach(request: TerminalAttachRequest): Promise<void> {
    const known = this.sessions.get(request.id);
    if (!known || this.state === "gone") return Promise.resolve();
    // The client's own point, until the attach's state replaces it: a connection restored before
    // then resumes it too.
    known.attach = {
      attachment: request.attachment,
      sent: this.state === "connected",
      since: request.since && { ...request.since },
    };
    return this.request<void>(
      { type: "attach", request },
      (value) => {
        RESULT_SCHEMAS.attach.parse(value);
      },
      { attach: true },
    );
  }

  detach(id: string): void {
    const known = this.sessions.get(id);
    if (known) known.attach = null;
    this.sendJson({ type: "detach", id });
  }

  write(id: string, data: Uint8Array): void {
    this.send(encodeFrame(encodeInputFrame(id, data)));
  }

  resize(id: string, cols: number, rows: number): void {
    this.sendJson({ type: "resize", id, cols, rows });
  }

  setScrollback(id: string, lines: number): void {
    this.sendJson({ type: "set_scrollback", id, lines });
  }

  ack(id: string, syncOffset: number, bytes: number): void {
    this.sendJson({ type: "ack", id, syncOffset, bytes });
  }

  destroy(id: string): void {
    this.sessions.delete(id);
    this.sendJson({ type: "destroy", id });
  }

  setMeta(id: string, meta: TerminalSessionMeta): void {
    this.sendJson({ type: "set_meta", id, meta });
  }

  /**
   * Capability `foregroundProcess`. A host without it, or one this server is not connected to right
   * now, can tell nothing, so the answer is empty.
   */
  foregroundProcesses(): Promise<ForegroundProcesses> {
    // Only on a live connection: one being restored may never be, and the caller is waiting.
    if (this.state !== "connected" || !this.supports("foregroundProcess")) {
      return Promise.resolve({});
    }
    return this.request({ type: "foreground_processes" }, (value) =>
      RESULT_SCHEMAS.foreground_processes.parse(value),
    );
  }

  onEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called once, when the host is gone or was left; its sessions are already reported ended. */
  onGone(listener: () => void): () => void {
    this.goneListeners.add(listener);
    return () => this.goneListeners.delete(listener);
  }

  /**
   * Leave the host, ending or keeping its sessions. Resolves once the host closed the connection,
   * so the message reached it. Reports no exits: the caller is done with these sessions.
   */
  disconnect(sessions: DisconnectMode): Promise<void> {
    return this.leave({ type: "disconnect", sessions }, sessions === "end");
  }

  /** End every session and the host, which may speak a protocol this server does not. */
  terminate(): Promise<void> {
    return this.leave({ type: "terminate" }, true);
  }

  /** Close the connection without a `disconnect`, as a crash would: the host's grace period runs. */
  drop(): void {
    const connection = this.connection;
    this.finish();
    connection?.destroy();
  }

  /**
   * `ends`: the message ends the sessions, which a SIGTERM does too when it cannot be sent. One
   * that keeps them must reach the host even while the connection is being restored, or the host,
   * in the grace period since the connection dropped, ends them when it runs out.
   */
  private leave(message: object, ends: boolean): Promise<void> {
    if (this.state === "gone") return Promise.resolve();
    // Connected, or restoring a connection that has done its handshake.
    const connection = this.connection;
    const attempt = this.connectAttempt;
    const pid = this.hello?.pid;
    this.finish();
    if (connection) return sendAndClose(connection, message);
    // A host still starting has no sessions yet, and exits once its first connection closes.
    if (pid === undefined) return Promise.resolve();
    // Reconnecting to it: the host takes SIGTERM as an order to end its sessions.
    if (ends) {
      signalHost(pid);
      return Promise.resolve();
    }
    return this.leaveOverNewConnection(message, attempt);
  }

  /**
   * Send `message` over a connection of its own, once the attempt to reconnect under way, if any,
   * has settled: its `initialize` must reach the host first, or the host would take it as the
   * newer server and ignore the message.
   */
  private async leaveOverNewConnection(
    message: object,
    attempt: Promise<HostConnection> | null,
  ): Promise<void> {
    await attempt?.catch(() => {});
    let connection: HostConnection;
    try {
      connection = await this.connect();
    } catch (err) {
      this.log.warn("Could not reach the terminal host to keep its sessions", { error: err });
      return;
    }
    await sendAndClose(connection, message);
  }

  /** Stop using the host: nothing more is sent, requests fail, and gone listeners run. */
  private finish(): void {
    if (this.state === "gone") return;
    this.state = "gone";
    this.connection = null;
    this.outbox = [];
    this.sessions.clear();
    const error = this.goneError();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.goneListeners) listener();
    this.goneListeners.clear();
  }

  private request<T>(
    message: object,
    parse: (value: unknown) => T,
    extra: Pick<PendingRequest, "spawn" | "attach"> = {},
  ): Promise<T> {
    const requestId = ++this.lastRequestId;
    const frame = encodeJsonFrame({ ...message, requestId });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        frame,
        resolve: (value) => resolve(value as T),
        reject,
        parse,
        sent: this.state === "connected",
        ...extra,
      });
      this.send(frame);
    });
  }

  private sendJson(message: object): void {
    this.send(encodeJsonFrame(message));
  }

  private send(frame: Uint8Array): void {
    if (this.state === "gone") return;
    if (this.state === "connected" && this.connection) this.connection.send(frame);
    else this.outbox.push(frame);
  }

  private onConnected(connection: HostConnection): void {
    if (this.state === "gone") {
      connection.destroy();
      return;
    }
    this.handshake(connection);
    connection.start({
      onBody: (body) => this.onBody(connection, body),
      onClose: (error) => this.onConnectionClosed(connection, error),
    });
    this.state = "connected";
    this.flushOutbox(connection);
  }

  /** Take `connection` and what its handshake says about the host. */
  private handshake(connection: HostConnection): void {
    this.hello = connection.result;
    this.capabilities = sharedCapabilities(connection.result, this.options.initialize);
    this.connection = connection;
  }

  /** Send what waited for the connection; from now on it counts as sent. */
  private flushOutbox(connection: HostConnection): void {
    for (const request of this.pending.values()) request.sent = true;
    for (const known of this.sessions.values()) if (known.attach) known.attach.sent = true;
    for (const frame of this.outbox.splice(0)) connection.send(frame);
  }

  private onBody(connection: HostConnection, body: FrameBody): void {
    if (this.connection !== connection) return;
    if (body.kind === "binary") {
      this.onOutput(body.bytes);
      return;
    }
    const parsed = HostMessageSchema.safeParse(body.value);
    if (!parsed.success) {
      this.log.error("Unreadable message from the terminal host, reconnecting", {
        error: parsed.error,
      });
      connection.destroy();
      return;
    }
    this.onMessage(parsed.data);
  }

  private onOutput(frame: Uint8Array): void {
    const output = parseOutputFrame(frame);
    if (!output) return;
    const { terminalId: id, offset, payload } = output;
    const since = this.sessions.get(id)?.attach?.since;
    if (since) since.offset = offset + payload.byteLength;
    this.emit({ type: "output", id, offset, data: payload, frame });
  }

  private onMessage(message: HostMessage): void {
    switch (message.type) {
      case "result": {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        this.pending.delete(message.requestId);
        try {
          request.resolve(request.parse(message.value));
        } catch (err) {
          request.reject(new Error("Unreadable answer from the terminal host", { cause: err }));
        }
        return;
      }
      case "error": {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        this.pending.delete(message.requestId);
        const cause = message.cause === undefined ? undefined : new Error(message.cause);
        request.reject(new Error(message.message, { cause }));
        return;
      }
      case "state": {
        const known = this.sessions.get(message.state.id);
        if (known?.attach?.attachment === message.attachment) {
          known.attach.since = { epoch: message.state.epoch, offset: message.state.offset };
        }
        this.emit(message);
        return;
      }
      case "exit": {
        if (this.sessions.get(message.id)?.epoch === message.epoch)
          this.sessions.delete(message.id);
        this.emit(message);
        return;
      }
      case "osc":
        this.emit(message);
        return;
      case "log": {
        const ctx = message.ctx;
        this.log[message.level](message.msg, ctx);
        return;
      }
      case "superseded":
        this.markGone("another server took it over");
        return;
      case "initialize_result":
        this.log.warn("Ignoring an initialize_result after the handshake");
        return;
      default: {
        const unknown: never = message;
        throw new Error(`Unhandled terminal host message ${JSON.stringify(unknown)}`);
      }
    }
  }

  private emit(event: TerminalHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private onConnectionClosed(connection: HostConnection, error?: Error): void {
    if (this.connection !== connection || this.state !== "connected") return;
    this.connection = null;
    this.state = "reconnecting";
    this.reconnectingSince ??= Date.now();
    this.log.warn("The connection to the terminal host closed, reconnecting", { error });
    // Answered by the restored connection's list() (spawns) or not at all (attaches: the host
    // detached every session, and the attaches to restore are re-sent below).
    for (const [requestId, request] of this.pending) {
      if (request.attach) {
        this.pending.delete(requestId);
        request.resolve(undefined);
      } else if (request.internal) {
        this.pending.delete(requestId);
        request.reject(new Error("The connection closed while it was being restored"));
      }
    }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const pid = this.hello?.pid;
    const isAlive = this.options.isProcessAlive ?? isProcessRunning;
    for (let attempt = 0; ; attempt++) {
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
      if (delay > 0)
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      if (this.state !== "reconnecting") return;
      if (pid !== undefined && !isAlive(pid)) {
        this.markGone(`its process ${pid} is not running`);
        return;
      }
      let connection: HostConnection;
      try {
        connection = await this.openForReconnect();
      } catch (err) {
        if (this.state !== "reconnecting") return;
        if (err instanceof HostConnectError && err.refused) {
          const reason = err.missing ? "its socket is gone" : "its socket refuses connections";
          this.markGone(reason, err);
          return;
        }
        this.log.warn("Could not reconnect to the terminal host yet", { error: err, attempt });
        continue;
      }
      if (this.state !== "reconnecting") {
        connection.destroy();
        return;
      }
      await this.restore(connection);
      return;
    }
  }

  /** Open a connection to restore, noted until it settles so that leaving meanwhile waits for it. */
  private openForReconnect(): Promise<HostConnection> {
    const opening = this.connect();
    this.connectAttempt = opening;
    const settled = () => {
      if (this.connectAttempt === opening) this.connectAttempt = null;
    };
    opening.then(settled, settled);
    return opening;
  }

  private connect(): Promise<HostConnection> {
    const connect = this.options.connect ?? openHostConnection;
    return connect(this.options.socketPath, this.options.initialize);
  }

  /** Bring the client in line with the host over a fresh connection, then resume sending. */
  private async restore(connection: HostConnection): Promise<void> {
    this.handshake(connection);
    connection.start({
      onBody: (body) => this.onBody(connection, body),
      onClose: (error) => {
        if (this.connection !== connection) return;
        // Closed again before it was restored: start over.
        this.state = "connected";
        this.onConnectionClosed(connection, error);
      },
    });
    const requestId = ++this.lastRequestId;
    const listed = new Promise<TerminalSessionInfo[]>((resolve, reject) => {
      this.pending.set(requestId, {
        frame: new Uint8Array(0),
        resolve: (value) => resolve(value as TerminalSessionInfo[]),
        reject,
        parse: (value) => RESULT_SCHEMAS.list.parse(value),
        sent: true,
        internal: true,
      });
    });
    connection.send(encodeJsonFrame({ type: "list", requestId }));
    let sessions: TerminalSessionInfo[];
    try {
      sessions = await listed;
    } catch (err) {
      if (this.connection === connection) {
        this.log.warn("Could not list the terminal host's sessions, reconnecting", { error: err });
        connection.destroy();
      }
      return;
    }
    if (this.connection !== connection) return;
    this.reconcile(connection, new Map(sessions.map((info) => [info.id, info])));
    // The exits reconcile reported may have led the caller to leave the host.
    if (this.state !== "reconnecting" || this.connection !== connection) return;
    this.state = "connected";
    this.reconnectingSince = null;
    // Requests the closed connection did not answer, then what was sent meanwhile, in order.
    for (const request of this.pending.values()) {
      if (request.sent) connection.send(request.frame);
    }
    this.flushOutbox(connection);
    this.log.info(`Reconnected to the terminal host (${sessions.length} sessions)`);
  }

  private reconcile(connection: HostConnection, running: Map<string, TerminalSessionInfo>): void {
    // Spawns the closed connection carried; the ones sent since are still in the outbox.
    for (const [requestId, request] of this.pending) {
      if (!request.spawn || !request.sent) continue;
      this.pending.delete(requestId);
      const info = running.get(request.spawn.id);
      if (info?.epoch === request.spawn.epoch) request.resolve(info);
      else
        request.reject(
          new Error("The connection to the terminal host closed before the spawn was answered"),
        );
    }
    // A destroy the closed connection lost: the host still runs a session nobody knows of.
    for (const id of running.keys()) {
      if (this.sessions.has(id)) continue;
      this.log.warn(
        `Ending terminal ${id.slice(0, 8)}, whose destroy was lost with the connection`,
      );
      connection.send(encodeJsonFrame({ type: "destroy", id }));
    }
    for (const [id, known] of this.sessions) {
      if (running.get(id)?.epoch === known.epoch) continue;
      if (!known.confirmed) continue;
      this.sessions.delete(id);
      this.log.warn(`Terminal ${id.slice(0, 8)} ended while the host was not connected`);
      this.emit({ type: "exit", id, epoch: known.epoch, exitCode: HOST_LOST_EXIT_CODE });
    }
    for (const [id, known] of this.sessions) {
      if (!known.attach?.sent) continue;
      const { attachment, since } = known.attach;
      const request: TerminalAttachRequest = since ? { id, attachment, since } : { id, attachment };
      connection.send(
        encodeJsonFrame({ type: "attach", requestId: ++this.lastRequestId, request }),
      );
    }
  }

  private markGone(reason: string, cause?: unknown): void {
    if (this.state === "gone") return;
    const lost = [...this.sessions].filter(([, known]) => known.confirmed);
    const build = this.hello?.hostBuildId ?? "unknown";
    if (lost.length > 0 || this.state !== "connecting") {
      this.log.error(`Terminal host is gone: ${reason}`, {
        hostBuildId: build,
        sessions: lost.length,
        error: cause instanceof Error ? cause : undefined,
      });
    }
    // Reported before the gone listeners run, while whoever routes to this host still does.
    for (const [id, known] of lost) {
      this.sessions.delete(id);
      this.emit({ type: "exit", id, epoch: known.epoch, exitCode: HOST_LOST_EXIT_CODE });
    }
    this.finish();
  }

  private goneError(): Error {
    return new Error(`Terminal host ${this.hostId} is not available`);
  }
}

/** Send `message` as the last thing on `connection`; resolves once the host has closed it. */
function sendAndClose(connection: HostConnection, message: object): Promise<void> {
  connection.send(encodeJsonFrame(message));
  return new Promise((resolve) => {
    connection.start({ onBody: () => {}, onClose: () => resolve() });
    connection.end();
  });
}

function signalHost(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
