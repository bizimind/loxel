/**
 * Terminal sessions keyed by the terminal ID, and the policy around them: the shell and its
 * environment, spawning on first attach (or up front for `loxel terminal`), the clients each
 * session streams to (through one host attachment, see {@link TerminalFanout}), orphans, worktree
 * lifecycle and which notification sequences count. The sessions themselves run in a
 * {@link TerminalHost}, reached only through its interface. See docs/TERMINALS.md and
 * docs/TERMINAL_HOST.md.
 */
import { z } from "zod";

import { DEFAULT_SCROLLBACK_LINES } from "@/api/terminal-limits";
import type { NotificationSequence, TerminalEnd } from "@/api/ws-protocol";
import { CODING_AGENT_ENV_VARS } from "@/coding-agent-env";
import type { OscPayload } from "@/lib/osc-notification-parser";
import { parseOsc777, parseOsc9, parseOsc99 } from "@/lib/osc-notification-parser";
import {
  FLOW_HIGH_WATER_BYTES,
  FLOW_LOW_WATER_BYTES,
  type ForegroundProcesses,
  type OscNotificationCode,
  type TerminalHost,
  type TerminalHostEvent,
  type TerminalSessionEnd,
  type TerminalSessionInfo,
} from "@/terminal-host";

import { logger } from "./logger";
import { buildShellSpawnEnv } from "./shell-env";
import { type FlowControl, TerminalFanout, type TerminalSink } from "./terminal-fanout";
import {
  commitToolchainEnvChange,
  type TerminalEnvChange,
  type TerminalToolchainSettings,
  type ToolchainEnvContributor,
} from "./toolchain-env-contributor";

const log = logger.child("terminal");
const textEncoder = new TextEncoder();

/** How long a new shell waits for its toolchains' environments before starting without them. */
const TOOLCHAIN_ENV_TIMEOUT_MS = 3000;

/** What the server keeps in a session's host meta, read back from the host after a restart. */
const TerminalMetaSchema = z.object({
  /**
   * The worktree the panel belongs to, or null for a Home terminal; follows the worktree when it
   * is moved.
   */
  worktreePath: z.string().nullable(),
  /** The directory the shell started in. */
  cwd: z.string(),
  /** The window that created the terminal, if any. */
  windowId: z.string().optional(),
});
export type TerminalMeta = z.infer<typeof TerminalMetaSchema>;

export interface TerminalSpawnOptions extends TerminalToolchainSettings {
  cols: number;
  rows: number;
  /** Applied only when the session is spawned. */
  cwd: string;
  /** The panel's worktree, absent for a Home terminal; applied only when spawned. */
  worktreePath?: string;
  /** The window creating the terminal; applied only when spawned. */
  windowId?: string;
  /** Applied only when the session is spawned. */
  envOverrides?: Record<string, string>;
  scrollbackLines?: number;
  /**
   * Typed into the shell as if the user had entered it. Applied only by the call that spawns the
   * shell and kept nowhere else, so a later respawn under the same ID (server restart, reload)
   * gets a plain shell and never runs it again.
   */
  command?: string;
}

export interface TerminalAttachOptions extends TerminalSpawnOptions {
  /** Session epoch and stream offset the client is already current to; see `terminal_attach`. */
  sinceEpoch?: string;
  sinceOffset?: number;
}

export interface TerminalManagerHooks {
  isSequenceEnabled: (sequence: NotificationSequence) => boolean;
  onNotification: (id: string, meta: TerminalMeta, payload: OscPayload) => void;
  /**
   * Called after a session that ended on its own (its program exited, or its host was lost) has
   * been removed.
   */
  onExit: (id: string, end: TerminalEnd) => void;
  /** What contributes to a new shell's environment, applied in this order. */
  toolchainEnvs: readonly ToolchainEnvContributor[];
  /** A session was added (spawned or adopted) or removed, for whoever lists them. */
  onSessionsChanged?: () => void;
}

/** The setting that enables each notification sequence, and how its payload is read. */
const OSC_NOTIFICATIONS: Record<
  OscNotificationCode,
  { sequence: NotificationSequence; parse: (data: string) => OscPayload | null }
> = {
  9: { sequence: "osc9", parse: parseOsc9 },
  777: { sequence: "osc777", parse: parseOsc777 },
  99: { sequence: "osc99", parse: parseOsc99 },
};

/** Build terminal-specific env: login shell PATH + TERM fallback. */
function buildTerminalEnv(): Record<string, string | undefined> {
  const env = buildShellSpawnEnv();
  if (!env.TERM) env.TERM = "xterm-256color";
  // A server started from an agent's session (e.g. a dev server) must not mark the user's shells
  // as an agent's, or their own `loxel` commands would open without focus.
  for (const name of CODING_AGENT_ENV_VARS) delete env[name];
  // Nor carry the Loxel terminal it was started from: each shell gets its own from the spawn's
  // overrides, and a Home terminal must have no worktree, so its `loxel` opens pages in its window.
  delete env.LOXEL_WORKTREE;
  delete env.LOXEL_WINDOW_ID;
  return env;
}

/** What `contributor` adds to a new shell in this worktree; null when it fails or runs out of time. */
async function resolveToolchainEnv(
  contributor: ToolchainEnvContributor,
  worktreePath: string,
  timedOut: Promise<"timeout">,
): Promise<TerminalEnvChange | null> {
  try {
    const change = await Promise.race([contributor.resolveForTerminal(worktreePath), timedOut]);
    if (change !== "timeout") return change;
    log.warn(`${contributor.name} environment took too long; starting the terminal without it`, {
      worktreePath,
    });
  } catch (err) {
    log.warn(`Could not activate the ${contributor.name} environment in a terminal`, {
      worktreePath,
      error: err,
    });
  }
  return null;
}

/** A shell waiting for its environment, and what reached it meanwhile. */
interface PendingStart {
  /** Null for a Home terminal, which belongs to no worktree. */
  worktreePath: string | null;
  /** Resolves to null when the terminal was destroyed meanwhile. */
  session: Promise<ManagedSession | null>;
  /**
   * The clients to bind once spawned, which a detach removes; the shell starts at the size the
   * latest of them asked for.
   */
  clients: TerminalFanout;
  /** Keystrokes sent before the shell existed, written to it in order once it does. */
  input: Uint8Array[];
}

/** A session running in the host, or being spawned there, as the manager sees it. */
interface ManagedSession {
  meta: TerminalMeta;
  /** Chosen here for each spawn, so events from an earlier spawn under the ID can be told apart. */
  epoch: string;
  /** Settles when the host has answered the spawn; rejects if it failed. */
  ready: Promise<void>;
  /**
   * The clients attached to the session, each added as soon as it attaches, even before the host
   * has answered; with none, the session is an orphan.
   */
  clients: TerminalFanout;
  /**
   * The host attachment feeding the clients, 0 while none is: only its states reach them. The
   * manager attaches once per session, and again only to sync a client that needs it.
   */
  attachment: number;
  /** The manager's attach whose state has not arrived yet, if any. */
  syncing: Promise<void> | null;
  /**
   * Set once its program ended while no server was connected, and the host kept it: the next
   * attach shows what its client missed, then its exit. It no longer counts as running, nor as an
   * orphan to end, so a panel that mounts later still gets what it missed.
   */
  ended: TerminalSessionEnd | null;
}

/** What `get()` reports about a session. */
export interface TerminalSessionView {
  meta: TerminalMeta;
  attached: boolean;
}

export class TerminalManager {
  private sessions = new Map<string, ManagedSession>();
  private starting = new Map<string, PendingStart>();
  /** Source of attachment numbers, unique across every session of this manager. */
  private lastAttachment = 0;
  private readonly flow: FlowControl;

  constructor(
    private readonly host: TerminalHost,
    private readonly hooks: TerminalManagerHooks,
    /** Each client's flow-control budget; overridden in tests. */
    flow: FlowControl = {
      highWaterBytes: FLOW_HIGH_WATER_BYTES,
      lowWaterBytes: FLOW_LOW_WATER_BYTES,
    },
  ) {
    this.flow = flow;
    host.onEvent((event) => this.onHostEvent(event));
  }

  private newFanout(id: string, size: { cols: number; rows: number }): TerminalFanout {
    return new TerminalFanout(id, size, this.flow);
  }

  /**
   * Take over sessions that are already running in the host, found there after a server restart.
   * They have no client until one attaches; one whose meta this server cannot read is ended.
   */
  adopt(sessions: readonly TerminalSessionInfo[]): void {
    for (const info of sessions) {
      const meta = TerminalMetaSchema.safeParse(info.meta);
      if (!meta.success) {
        log.warn(`Ending terminal ${info.id.slice(0, 8)}, whose meta this server cannot read`, {
          error: meta.error,
        });
        this.host.destroy(info.id);
        continue;
      }
      this.sessions.set(info.id, {
        meta: meta.data,
        epoch: info.epoch,
        ready: Promise.resolve(),
        clients: this.newFanout(info.id, { cols: info.cols, rows: info.rows }),
        attachment: 0,
        syncing: null,
        ended: info.ended ?? null,
      });
    }
    this.hooks.onSessionsChanged?.();
  }

  /** Every session running in the host, or being spawned there, with its meta. */
  running(): { id: string; meta: TerminalMeta }[] {
    return [...this.sessions]
      .filter(([, session]) => !session.ended)
      .map(([id, session]) => ({ id, meta: session.meta }));
  }

  /** The foreground program of each session whose host can tell; see `TerminalHost`. */
  foregroundProcesses(): Promise<ForegroundProcesses> {
    return this.host.foregroundProcesses();
  }

  get(id: string): TerminalSessionView | undefined {
    const session = this.sessions.get(id);
    return session && { meta: session.meta, attached: session.clients.attached };
  }

  /** Whether any client is attached to terminal `id`, a shell still starting included. */
  hasClients(id: string): boolean {
    const clients = this.sessions.get(id)?.clients ?? this.starting.get(id)?.clients;
    return clients?.attached ?? false;
  }

  /**
   * Attach a client to the session, spawning the shell first if the session does not exist. It
   * joins the clients already attached and becomes the active one, so the PTY takes its size.
   * Resolves once the host has sent the state that syncs it, or rejects if the host failed to.
   */
  async attach(id: string, sink: TerminalSink, options: TerminalAttachOptions): Promise<void> {
    const { sinceEpoch, sinceOffset } = options;
    const since =
      sinceEpoch !== undefined && sinceOffset !== undefined
        ? { epoch: sinceEpoch, offset: sinceOffset }
        : undefined;
    const size = { cols: options.cols, rows: options.rows };
    const scrollbackLines = options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    const running = this.sessions.get(id);
    if (running) {
      if (running.clients.attach(sink, size, since)) this.resizeHost(id, running);
      this.host.setScrollback(id, scrollbackLines);
      // The host may still be answering the spawn; this attach then fails if the spawn does.
      await running.ready;
      return this.syncClient(id, running, sink);
    }

    const pending = this.start(id, options);
    pending.clients.attach(sink, size, since);
    const session = await pending.session;
    if (!session) return;
    this.host.setScrollback(id, scrollbackLines);
    return this.syncClient(id, session, sink);
  }

  /**
   * Sync `sink`, unless it was detached or the session ended since it attached. An attach already
   * in flight may be a resume that does not suit it, so it waits for as many as it takes.
   */
  private async syncClient(id: string, session: ManagedSession, sink: TerminalSink): Promise<void> {
    while (this.sessions.get(id) === session && session.clients.isWaiting(sink)) {
      const syncing = this.sync(id, session);
      await syncing;
      // Settled before its state arrived, which then syncs the client when it does.
      if (session.syncing === syncing) return;
    }
  }

  /**
   * Attach the session in the host again, if a client waits for a state: a client that just
   * attached, or one that caught up after a pause. One attach at a time serves every client
   * waiting meanwhile. Clients already live are at the offset of the snapshot the host answers
   * with, so they carry on untouched.
   */
  private sync(id: string, session: ManagedSession): Promise<void> {
    if (session.syncing) return session.syncing;
    if (!session.clients.needsSync()) return Promise.resolve();
    const attachment = ++this.lastAttachment;
    session.attachment = attachment;
    const syncing = this.host.attach({ id, attachment, since: session.clients.resumePoint() });
    session.syncing = syncing;
    // Its state clears it on arrival; one that fails never sends one, and the next sync retries.
    syncing.catch(() => {
      if (session.syncing === syncing) session.syncing = null;
    });
    return syncing;
  }

  /** A sync the manager starts on its own, with no client's attach waiting on it to report. */
  private resync(id: string, session: ManagedSession): void {
    this.sync(id, session).catch((err: unknown) => {
      log.warn(`Could not resync terminal ${id.slice(0, 8)}`, { error: err });
    });
  }

  private resizeHost(id: string, session: ManagedSession): void {
    const { cols, rows } = session.clients.ptySize;
    this.host.resize(id, cols, rows);
  }

  /**
   * Spawn the shell of terminal `id` with no client attached, unless it is already running. For
   * `loxel terminal`, whose panel may not mount for a long time, if ever: its command runs now,
   * and the panel's first attach binds to the session.
   */
  async ensureSpawned(id: string, options: TerminalSpawnOptions): Promise<void> {
    if (!this.sessions.has(id)) await this.start(id, options).session;
  }

  /**
   * Spawn once the environment is ready. Concurrent callers for the same ID share one spawn (the
   * first caller's options apply), and one destroyed before its environment is ready never starts.
   */
  private start(id: string, options: TerminalSpawnOptions): PendingStart {
    const existing = this.starting.get(id);
    if (existing) return existing;
    const pending: PendingStart = {
      session: this.buildEnv(options).then((env) => {
        if (this.starting.get(id) !== pending) return null;
        this.starting.delete(id);
        return this.spawn(id, options, pending, env);
      }),
      worktreePath: options.worktreePath ?? null,
      clients: this.newFanout(id, { cols: options.cols, rows: options.rows }),
      input: [],
    };
    this.starting.set(id, pending);
    return pending;
  }

  private async buildEnv(
    options: TerminalSpawnOptions,
  ): Promise<Record<string, string | undefined>> {
    const env = buildTerminalEnv();
    if (options.envOverrides) Object.assign(env, options.envOverrides);
    // A Home terminal's toolchains are those of the directory it starts in.
    const worktreePath = options.worktreePath ?? options.cwd;
    const contributors = this.hooks.toolchainEnvs.filter(
      (contributor) => contributor.enabledInTerminal?.(options) ?? true,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), TOOLCHAIN_ENV_TIMEOUT_MS);
    });
    // Resolved side by side, so a slow toolchain costs the others no time, and applied in list
    // order, since several can change the same variable.
    const changes = await Promise.all(
      contributors.map((contributor) => resolveToolchainEnv(contributor, worktreePath, timedOut)),
    );
    clearTimeout(timer);
    for (const [index, change] of changes.entries()) {
      if (!change) continue;
      try {
        const changed = { ...env };
        await change(changed, terminalShell());
        commitToolchainEnvChange(env, changed);
      } catch (err) {
        log.warn(`Could not activate the ${contributors[index]?.name} environment in a terminal`, {
          worktreePath,
          error: err,
        });
      }
    }
    return env;
  }

  /**
   * Start the shell in the host. The session is registered, with the clients waiting for it, in
   * the same step as the host is asked, so input, resizes, attaches, detaches and a destroy that
   * arrive meanwhile go to the host after the spawn, in order. Resolves to null if the session ended meanwhile.
   */
  private async spawn(
    id: string,
    options: TerminalSpawnOptions,
    pending: PendingStart,
    env: Record<string, string | undefined>,
  ): Promise<ManagedSession | null> {
    const shell = terminalShell();
    const { cwd, windowId, command } = options;
    const { cols, rows } = pending.clients.ptySize;
    log.info(`Spawning terminal ${id.slice(0, 8)} with ${shell} (${cols}x${rows}) in ${cwd}`);

    const meta: TerminalMeta = { worktreePath: pending.worktreePath, cwd };
    if (windowId !== undefined) meta.windowId = windowId;
    const epoch = crypto.randomUUID();

    // Typed ahead: the PTY queues the bytes until the shell reads its first line, so the command
    // shows up at the prompt and in shell history exactly as if the user had entered it.
    const typed = command === undefined ? [] : [textEncoder.encode(`${command}\n`)];
    const spawned = this.host.spawn({
      id,
      epoch,
      argv: [shell, "-il"],
      cwd,
      env: definedEnv(env),
      cols,
      rows,
      scrollbackLines: options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
      meta,
      input: new Uint8Array(Bun.concatArrayBuffers([...typed, ...pending.input])),
    });
    const session: ManagedSession = {
      meta,
      epoch,
      ready: spawned.then(() => {}),
      clients: pending.clients,
      attachment: 0,
      syncing: null,
      ended: null,
    };
    this.sessions.set(id, session);
    this.hooks.onSessionsChanged?.();
    try {
      await session.ready;
    } catch (err) {
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
        this.hooks.onSessionsChanged?.();
      }
      throw err;
    }
    return this.sessions.get(id) === session ? session : null;
  }

  private onHostEvent(event: TerminalHostEvent): void {
    switch (event.type) {
      case "state": {
        const { id } = event.state;
        const session = this.sessions.get(id);
        // A state for an attach since superseded, or dropped when the last client detached.
        if (!session || session.attachment === 0 || session.attachment !== event.attachment) {
          return;
        }
        const requested = session.syncing !== null;
        session.syncing = null;
        session.clients.applyState(event.state, requested);
        // A resume only serves the clients current to its point; the others need a snapshot.
        this.resync(id, session);
        return;
      }
      case "output": {
        const session = this.sessions.get(event.id);
        if (!session || session.attachment === 0) return;
        session.clients.forward(event);
        return;
      }
      case "exit": {
        const outputLost = this.sessions.get(event.id)?.ended?.outputKept === false;
        this.onEnded(event.id, event.epoch, {
          reason: "exited",
          exitCode: event.exitCode,
          outputLost,
        });
        return;
      }
      case "ended": {
        const session = this.sessions.get(event.id);
        if (!session || session.epoch !== event.epoch) return;
        const known = session.ended;
        if (known?.exitCode === event.exitCode && known.outputKept === event.outputKept) return;
        // Listed again on every restored connection; the host may have let its output go since.
        session.ended = { exitCode: event.exitCode, outputKept: event.outputKept };
        log.info(`Terminal ${event.id.slice(0, 8)} ended with code ${event.exitCode} meanwhile`);
        this.hooks.onSessionsChanged?.();
        return;
      }
      case "lost":
        this.onEnded(
          event.id,
          event.epoch,
          event.reason === "host_lost"
            ? { reason: "host_lost" }
            : { reason: "exited", exitCode: null, outputLost: true },
        );
        return;
      case "osc": {
        const session = this.sessions.get(event.id);
        if (!session || session.epoch !== event.epoch) return;
        const { sequence, parse } = OSC_NOTIFICATIONS[event.code];
        if (!this.hooks.isSequenceEnabled(sequence)) return;
        const payload = parse(event.data);
        if (payload) this.hooks.onNotification(event.id, session.meta, payload);
        return;
      }
      case "unresponsive": {
        const session = this.sessions.get(event.id);
        if (session?.epoch !== event.epoch) return;
        session.clients.sendNotice({ notice: "host_unresponsive" });
        return;
      }
      default: {
        const unknownEvent: never = event;
        throw new Error(`Unknown terminal host event: ${JSON.stringify(unknownEvent)}`);
      }
    }
  }

  private onEnded(id: string, epoch: string, end: TerminalEnd): void {
    const session = this.sessions.get(id);
    if (!session || session.epoch !== epoch) return;
    this.sessions.delete(id);
    session.clients.sendExit(end);
    this.hooks.onExit(id, end);
    this.hooks.onSessionsChanged?.();
  }

  /**
   * Stop streaming to `sink`. The other clients stay attached; once the last one is gone, the host
   * stops sending and the session is an orphan.
   */
  detach(id: string, sink: TerminalSink): void {
    this.starting.get(id)?.clients.detach(sink);
    const session = this.sessions.get(id);
    if (!session?.clients.detach(sink) || session.clients.attached) return;
    session.attachment = 0;
    session.syncing = null;
    this.host.detach(id);
  }

  /**
   * Input from `sink`, written only if it is the active client. A client claims the terminal
   * before its user's input, so what this drops are the replies of the other clients' xterms to
   * terminal queries, which the active one answers already.
   */
  write(id: string, sink: TerminalSink, data: Uint8Array): void {
    const session = this.sessions.get(id);
    if (session) {
      if (session.clients.isActive(sink)) this.host.write(id, data);
      return;
    }
    const pending = this.starting.get(id);
    if (pending?.clients.isActive(sink)) pending.input.push(data);
  }

  /** `sink` claims the terminal (see `TerminalFanout.claim`): the PTY takes its size. */
  resize(id: string, sink: TerminalSink, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session) {
      if (session.clients.claim(sink, { cols, rows })) this.resizeHost(id, session);
      return;
    }
    this.starting.get(id)?.clients.claim(sink, { cols, rows });
  }

  ack(id: string, sink: TerminalSink, syncOffset: number, bytes: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const { resync, hostAck } = session.clients.ack(sink, syncOffset, bytes);
    if (hostAck) this.host.ack(id, hostAck.syncOffset, hostAck.bytes);
    if (!resync) return;
    log.info(`Terminal ${id.slice(0, 8)} client caught up, resyncing it with a snapshot`);
    this.resync(id, session);
  }

  destroy(id: string): void {
    this.starting.delete(id);
    if (!this.sessions.delete(id)) return;
    this.host.destroy(id);
    this.hooks.onSessionsChanged?.();
  }

  /**
   * End every session of a removed worktree, `delayMs` from now, calling `onEnded` with each one
   * that was still running. Only the sessions there now: a worktree created at the same path
   * meanwhile keeps its own. A shell still waiting for its environment never starts.
   */
  endWorktreeSessions(worktreePath: string, delayMs: number, onEnded: (id: string) => void): void {
    for (const [id, pending] of this.starting) {
      if (pending.worktreePath !== worktreePath) continue;
      this.destroy(id);
      onEnded(id);
    }
    const sessions = [...this.sessions].filter(([, s]) => s.meta.worktreePath === worktreePath);
    const end = () => {
      for (const [id, session] of sessions) {
        // Exited or closed meanwhile, or already ended by the other removal path.
        if (this.sessions.get(id) !== session) continue;
        this.destroy(id);
        onEnded(id);
      }
    };
    if (delayMs === 0) end();
    else if (sessions.length > 0) setTimeout(end, delayMs).unref();
  }

  /** A moved worktree keeps its sessions, so removing it later still ends them. */
  retargetWorktree(from: string, to: string): void {
    for (const pending of this.starting.values()) {
      if (pending.worktreePath === from) pending.worktreePath = to;
    }
    for (const [id, session] of this.sessions) {
      if (session.meta.worktreePath !== from) continue;
      session.meta = { ...session.meta, worktreePath: to };
      this.host.setMeta(id, session.meta);
    }
  }

  /** True if any running session has no client attached, other than those `kept`. */
  hasOrphanSessions(kept: (id: string) => boolean = () => false): boolean {
    return this.orphans(kept).length > 0;
  }

  /**
   * Destroy every running session without an attached client, other than those `kept` (a panel
   * for them is on its way). Ended ones are kept for their panels to show what they missed.
   * Returns the number destroyed.
   */
  destroyOrphans(kept: (id: string) => boolean = () => false): number {
    const orphans = this.orphans(kept);
    for (const id of orphans) this.destroy(id);
    return orphans.length;
  }

  private orphans(kept: (id: string) => boolean): string[] {
    return [...this.sessions]
      .filter(([id, s]) => !s.clients.attached && !s.ended && !kept(id))
      .map(([id]) => id);
  }

  destroyAll(): void {
    this.starting.clear();
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }
}

function terminalShell(): string {
  return process.env.SHELL || "/bin/bash";
}

/** The environment as the host takes it: unset variables are left out. */
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}
