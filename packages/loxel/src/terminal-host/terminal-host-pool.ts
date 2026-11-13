/**
 * Every terminal host a server uses, as one {@link TerminalHost}: the server's side of host
 * generations. See docs/TERMINAL_HOST.md#generations.
 *
 * - At startup the pool finds the hosts in the run directory, handshakes with each, ends the ones
 *   it cannot talk to, removes stale entries, and reads every compatible host's sessions, which
 *   the caller adopts.
 * - New sessions spawn in the current generation's host: a running host with this build's host
 *   build ID, or else one started the first time a session is spawned.
 * - Every other command goes to the host that runs its session. A host of an earlier generation
 *   serves its sessions until the last one ends, and is then let go, which ends it.
 * - Binaries no host uses, and old logs of hosts that are gone, are removed.
 */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ChildLogger } from "@/api/log-entry-model";

import type { HostConnection } from "./host-connection";
import { HostConnectError, openHostConnection } from "./host-connection";
import {
  HOST_LOG_PREFIX,
  type HostEntry,
  HostEntrySchema,
  ensureRunDir,
  hostBinDir,
  hostEntryPath,
  hostLogsDir,
  hostRunDir,
  hostSocketDir,
  hostSocketPath,
  isProcessRunning,
  isHostId,
  newHostId,
} from "./host-files";
import type { HostLaunch, LaunchedHost } from "./host-launcher";
import { launchHost } from "./host-launcher";
import type { DisconnectMode, InitializeMessage } from "./protocol";
import { TERMINAL_HOST_CAPABILITIES, TERMINAL_HOST_PROTOCOL, compatibility } from "./protocol";
import { encodeJsonFrame } from "./protocol-framing";
import { SocketTerminalHost } from "./socket-terminal-host";
import type {
  TerminalAttachRequest,
  TerminalHost,
  TerminalHostEvent,
  TerminalScreen,
  TerminalSessionInfo,
  TerminalSessionMeta,
  TerminalSpawnRequest,
} from "./terminal-host";

/** How long a terminated host has to close its socket before it gets a SIGTERM. */
const TERMINATE_TIMEOUT_MS = 2000;
/** Logs of hosts that are gone are kept this long, for a look at why. */
const STALE_LOG_AGE_MS = 24 * 60 * 60_000;

export interface TerminalHostPoolOptions {
  stateDir: string;
  /** The server's build, sent in `initialize` for the hosts' logs. */
  serverBuild: string;
  /** This build's host build ID. */
  hostBuildId: string;
  log: ChildLogger;
  /** Starts a host; tests replace it. */
  launch?: (launch: HostLaunch) => Promise<LaunchedHost>;
  /** Override the run and socket directories, for tests. */
  runDir?: string;
  socketDir?: string;
}

/** The host a session runs in, and which spawn of its ID that is. */
interface Owner {
  host: SocketTerminalHost;
  epoch: string;
}

export class TerminalHostPool implements TerminalHost {
  private readonly runDir: string;
  private readonly socketDir: string;
  private readonly log: ChildLogger;
  private readonly initialize: InitializeMessage;
  private readonly hosts = new Set<SocketTerminalHost>();
  /** The host new sessions spawn in, once there is one. */
  private current: SocketTerminalHost | null = null;
  /** The host each session runs in. */
  private readonly owners = new Map<string, Owner>();
  private readonly listeners = new Set<(event: TerminalHostEvent) => void>();
  /** Events held back until the caller has adopted the sessions found at startup. */
  private held: TerminalHostEvent[] | null = [];
  private closed = false;

  constructor(private readonly options: TerminalHostPoolOptions) {
    this.runDir = options.runDir ?? hostRunDir(options.stateDir);
    this.socketDir = options.socketDir ?? hostSocketDir(options.stateDir);
    this.log = options.log;
    if (this.socketDir !== this.runDir) {
      this.log.warn(
        `The state directory is too deep for a socket path; terminal host sockets are in ${this.socketDir}, where the system may purge them after a few days unused`,
      );
    }
    this.initialize = {
      type: "initialize",
      protocol: TERMINAL_HOST_PROTOCOL,
      build: options.serverBuild,
      capabilities: [...TERMINAL_HOST_CAPABILITIES],
    };
  }

  /**
   * Find the running hosts and hand their sessions to `adopt`. Events of those sessions are
   * delivered only after `adopt` returns, so none arrives for a session the caller does not know yet.
   */
  async start(adopt: (sessions: TerminalSessionInfo[]) => void): Promise<void> {
    try {
      await this.discoverAll(adopt);
    } finally {
      // Delivered even when discovery failed, or every later session would stay mute.
      const held = this.held ?? [];
      this.held = null;
      for (const event of held) this.deliver(event);
    }
  }

  private async discoverAll(adopt: (sessions: TerminalSessionInfo[]) => void): Promise<void> {
    ensureRunDir(this.runDir);
    ensureRunDir(this.socketDir);
    const found = await Promise.all(
      this.knownHostIds().map((hostId) =>
        this.discover(hostId).catch((err: unknown) => {
          this.log.error(`Could not check terminal host ${hostId}`, { error: err });
          return { hostId, build: "", host: null };
        }),
      ),
    );
    const sessions: TerminalSessionInfo[] = [];
    const keepBuilds = new Set([this.options.hostBuildId]);
    const liveHostIds = new Set<string>();
    for (const result of found) {
      if (!result) continue;
      liveHostIds.add(result.hostId);
      keepBuilds.add(result.build);
      if (!result.host) continue;
      for (const info of result.sessions) {
        if (this.owners.has(info.id)) {
          this.log.warn(`Terminal ${info.id.slice(0, 8)} runs in two hosts; using one`);
          continue;
        }
        this.owners.set(info.id, { host: result.host, epoch: info.epoch });
        sessions.push(info);
      }
      if (!this.current && result.build === this.options.hostBuildId) this.current = result.host;
    }
    for (const host of this.hosts) this.retireIfDone(host);
    adopt(sessions);
    if (sessions.length > 0) {
      this.log.info(`Reattached ${sessions.length} terminal(s) from ${this.hosts.size} host(s)`);
    }
    this.collectGarbage(keepBuilds, liveHostIds);
  }

  spawn(request: TerminalSpawnRequest): Promise<TerminalSessionInfo> {
    if (this.closed) return Promise.reject(new Error("The terminal hosts are shut down"));
    const host = this.currentHost();
    const owner: Owner = { host, epoch: request.epoch };
    this.owners.set(request.id, owner);
    return host.spawn(request).catch((err: unknown) => {
      if (this.owners.get(request.id) === owner) this.owners.delete(request.id);
      throw err;
    });
  }

  async list(): Promise<TerminalSessionInfo[]> {
    const lists = await Promise.all([...this.hosts].map((host) => host.list().catch(() => [])));
    return lists.flat();
  }

  attach(request: TerminalAttachRequest): Promise<void> {
    return this.owners.get(request.id)?.host.attach(request) ?? Promise.resolve();
  }

  detach(id: string): void {
    this.owners.get(id)?.host.detach(id);
  }

  write(id: string, data: Uint8Array): void {
    this.owners.get(id)?.host.write(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.owners.get(id)?.host.resize(id, cols, rows);
  }

  setScrollback(id: string, lines: number): void {
    this.owners.get(id)?.host.setScrollback(id, lines);
  }

  ack(id: string, syncOffset: number, bytes: number): void {
    this.owners.get(id)?.host.ack(id, syncOffset, bytes);
  }

  destroy(id: string): void {
    const host = this.owners.get(id)?.host;
    if (!host) return;
    this.owners.delete(id);
    host.destroy(id);
    this.retireIfDone(host);
  }

  setMeta(id: string, meta: TerminalSessionMeta): void {
    this.owners.get(id)?.host.setMeta(id, meta);
  }

  screen(id: string): Promise<TerminalScreen | null> {
    return this.owners.get(id)?.host.screen(id) ?? Promise.resolve(null);
  }

  onEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Leave every host, ending or keeping its sessions; resolves once each has the message. */
  async disconnectAll(sessions: DisconnectMode): Promise<void> {
    this.closed = true;
    await Promise.all([...this.hosts].map((host) => host.disconnect(sessions)));
  }

  /** Close every connection as a crash would, leaving the hosts to their grace period. */
  dropAll(): void {
    this.closed = true;
    for (const host of this.hosts) host.drop();
  }

  /** Every host with an entry or a socket. */
  private knownHostIds(): string[] {
    const ids = new Set<string>();
    for (const name of [...readdirSync(this.runDir), ...readdirSync(this.socketDir)]) {
      const match = /^(.+)\.(sock|json)$/.exec(name);
      if (match && isHostId(match[1]!)) ids.add(match[1]!);
    }
    return [...ids];
  }

  /**
   * Handshake with the host `hostId`. Null when it is gone (its entry is removed); without `host`
   * when it is running but not usable, so its files are kept.
   */
  private async discover(
    hostId: string,
  ): Promise<
    | { hostId: string; build: string; host: SocketTerminalHost; sessions: TerminalSessionInfo[] }
    | { hostId: string; build: string; host: null }
    | null
  > {
    const entry = this.readEntry(hostId);
    const socketPath = entry?.socket ?? hostSocketPath(this.socketDir, hostId);
    let connection: HostConnection;
    try {
      connection = await openHostConnection(socketPath, this.initialize);
    } catch (err) {
      if (!(err instanceof HostConnectError && err.refused)) {
        this.log.warn(`Terminal host ${hostId} did not answer; leaving it be`, { error: err });
        return { hostId, build: entry?.build ?? "", host: null };
      }
      // Its socket was removed under it (a purge of the temporary directory): the host runs, but
      // nothing can reach it or its sessions again.
      if (err.missing && entry && isProcessRunning(entry.pid)) {
        this.log.error(`Terminal host ${hostId} is unreachable: its socket is gone`, {
          pid: entry.pid,
          hostBuildId: entry.build,
          socketPath,
        });
        return { hostId, build: entry.build, host: null };
      }
      this.log.info(`Removing the entry of terminal host ${hostId}, which is gone`);
      rmSync(socketPath, { force: true });
      rmSync(hostEntryPath(this.runDir, hostId), { force: true });
      return null;
    }

    const { result } = connection;
    const verdict = compatibility(result, this.initialize);
    if (verdict.status === "incompatible") {
      this.log.warn(`Ending terminal host ${hostId}: ${verdict.reason}`);
      await terminateHost(connection);
      return null;
    }
    const host = this.addHost(hostId, socketPath, Promise.resolve(connection));
    try {
      const sessions = await host.list();
      return { hostId, build: result.hostBuildId, host, sessions };
    } catch (err) {
      this.log.warn(`Could not list the sessions of terminal host ${hostId}`, { error: err });
      // Left be: closing the connection without a disconnect gives it its grace period.
      host.drop();
      return { hostId, build: result.hostBuildId, host: null };
    }
  }

  /** The host's entry, or null when it has none or it cannot be read. */
  private readEntry(hostId: string): HostEntry | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(hostEntryPath(this.runDir, hostId), "utf8"));
      return HostEntrySchema.parse(raw);
    } catch {
      return null;
    }
  }

  private addHost(
    hostId: string,
    socketPath: string,
    connection: Promise<HostConnection>,
  ): SocketTerminalHost {
    const host = new SocketTerminalHost(
      { hostId, socketPath, initialize: this.initialize, log: this.log },
      connection,
    );
    this.hosts.add(host);
    host.onEvent((event) => this.onHostEvent(host, event));
    host.onGone(() => {
      this.hosts.delete(host);
      if (this.current === host) this.current = null;
      for (const [id, owner] of this.owners) {
        if (owner.host === host) this.owners.delete(id);
      }
    });
    return host;
  }

  /** The host new sessions go to, started when there is none. */
  private currentHost(): SocketTerminalHost {
    if (this.current?.acceptsNewSessions) return this.current;
    if (this.current && !this.current.isGone) {
      this.log.warn(
        `Terminal host ${this.current.hostId} has been unreachable too long; starting another for new terminals`,
      );
    }
    const hostId = newHostId();
    const socketPath = hostSocketPath(this.socketDir, hostId);
    const { hostBuildId, stateDir } = this.options;
    const launch = this.options.launch ?? launchHost;
    this.log.info(`Starting terminal host ${hostId} (${hostBuildId})`);
    const connection = launch({
      stateDir,
      runDir: this.runDir,
      socketDir: this.socketDir,
      hostId,
      hostBuildId,
    }).then(async (launched) => {
      const opened = await openHostConnection(launched.socketPath, this.initialize);
      if (opened.result.hostBuildId !== hostBuildId) {
        this.log.warn(
          `Terminal host ${hostId} reports build ${opened.result.hostBuildId}, not ${hostBuildId}`,
        );
      }
      return opened;
    });
    connection.catch((err: unknown) => {
      this.log.error(`Could not start terminal host ${hostId}`, { error: err });
    });
    const host = this.addHost(hostId, socketPath, connection);
    this.current = host;
    return host;
  }

  private onHostEvent(host: SocketTerminalHost, event: TerminalHostEvent): void {
    if (event.type === "exit") this.onHostExit(host, event.id, event.epoch);
    if (this.held) this.held.push(event);
    else this.deliver(event);
  }

  /**
   * Only the exit of the spawn that is routed ends its route: a late exit of an earlier spawn under
   * the same ID must not cut its replacement off.
   */
  private onHostExit(host: SocketTerminalHost, id: string, epoch: string): void {
    const owner = this.owners.get(id);
    if (owner?.host !== host || owner.epoch !== epoch) return;
    this.owners.delete(id);
    this.retireIfDone(host);
  }

  private deliver(event: TerminalHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Let go of an earlier generation's host once it has no sessions left; it then exits. */
  private retireIfDone(host: SocketTerminalHost): void {
    if (host === this.current || this.closed) return;
    for (const owner of this.owners.values()) if (owner.host === host) return;
    this.hosts.delete(host);
    this.log.info(`Terminal host ${host.hostId} has no sessions left, letting it go`);
    void host.disconnect("end");
  }

  /**
   * Remove `bin/<hostBuildId>` directories of builds no live host runs and that are not this
   * build's, and logs of hosts that are gone, once they are a day old.
   */
  private collectGarbage(keepBuilds: Set<string>, liveHostIds: Set<string>): void {
    const binDir = hostBinDir(this.options.stateDir);
    for (const build of readdirOrEmpty(binDir)) {
      if (keepBuilds.has(build)) continue;
      this.log.info(`Removing the unused terminal host binary ${build}`);
      rmSync(join(binDir, build), { recursive: true, force: true });
    }
    const logsDir = hostLogsDir(this.options.stateDir);
    const now = Date.now();
    for (const name of readdirOrEmpty(logsDir)) {
      if (!name.startsWith(HOST_LOG_PREFIX)) continue;
      const hostId = name.slice(HOST_LOG_PREFIX.length).split(".")[0] ?? "";
      if (liveHostIds.has(hostId)) continue;
      const path = join(logsDir, name);
      try {
        if (now - statSync(path).mtimeMs > STALE_LOG_AGE_MS) rmSync(path, { force: true });
      } catch {
        // Removed meanwhile.
      }
    }
  }
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * End a host this server cannot talk to, over the frozen bootstrap layer; one that does not close
 * its socket in time gets a SIGTERM, which it also takes as an order to end its sessions.
 */
async function terminateHost(connection: HostConnection): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    connection.start({ onBody: () => {}, onClose: () => resolve() });
  });
  connection.send(encodeJsonFrame({ type: "terminate" }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), TERMINATE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  if (outcome !== "timeout") return;
  connection.destroy();
  try {
    process.kill(connection.result.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
