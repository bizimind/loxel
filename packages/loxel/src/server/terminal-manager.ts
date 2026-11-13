/**
 * Terminal sessions keyed by the terminal ID, and the policy around them: the shell and its
 * environment, spawning on first attach (or up front for `loxel terminal`), the client each session
 * streams to, orphans, worktree lifecycle and which notification sequences count. The sessions
 * themselves run in a {@link TerminalHost}, reached only through its interface. See
 * docs/TERMINALS.md and docs/TERMINAL_HOST.md.
 */
import { z } from "zod";

import { DEFAULT_SCROLLBACK_LINES } from "@/api/terminal-limits";
import type { TerminalState } from "@/api/terminal-stream";
import type { NotificationSequence } from "@/api/ws-protocol";
import { CODING_AGENT_ENV_VARS } from "@/coding-agent-env";
import type { OscPayload } from "@/lib/osc-notification-parser";
import { parseOsc777, parseOsc9, parseOsc99 } from "@/lib/osc-notification-parser";
import type {
  OscNotificationCode,
  TerminalHost,
  TerminalHostEvent,
  TerminalOutputEvent,
  TerminalSessionInfo,
} from "@/terminal-host";

import { logger } from "./logger";
import { buildShellSpawnEnv } from "./shell-env";
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

export type TerminalOutput = Omit<TerminalOutputEvent, "type" | "id">;

/** Where a session delivers messages for its attached client. */
export interface TerminalSink {
  sendState(state: TerminalState): void;
  /** Output from the host, with the renderer frame to forward as is. */
  sendOutput(output: TerminalOutput): void;
  sendExit(exitCode: number): void;
}

/** What the server keeps in a session's host meta, read back from the host after a restart. */
const TerminalMetaSchema = z.object({
  /** The worktree the panel belongs to; follows the worktree when it is moved. */
  worktreePath: z.string(),
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
  /** The panel's worktree when the shell starts elsewhere; applied only when spawned. */
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
  /** Called after a session whose program exited on its own has been removed. */
  onExit: (id: string, exitCode: number) => void;
  /** What contributes to a new shell's environment, applied in this order. */
  toolchainEnvs: readonly ToolchainEnvContributor[];
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
  worktreePath: string;
  /** Resolves to null when the terminal was destroyed meanwhile. */
  session: Promise<ManagedSession | null>;
  /** The client to bind once spawned; cleared by a detach. */
  sink: TerminalSink | null;
  /** The latest size an attach or resize asked for. */
  size: { cols: number; rows: number } | null;
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
   * The client the session belongs to, set as soon as it attaches, even before the host has
   * answered; null while detached, which makes the session an orphan.
   */
  sink: TerminalSink | null;
  /** The attachment of the sink's attach, 0 until it is sent; only its states reach the sink. */
  attachment: number;
  /** True once the sink has received its state: output from then on is its own. */
  live: boolean;
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

  constructor(
    private readonly host: TerminalHost,
    private readonly hooks: TerminalManagerHooks,
  ) {
    host.onEvent((event) => this.onHostEvent(event));
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
        sink: null,
        attachment: 0,
        live: false,
      });
    }
  }

  get(id: string): TerminalSessionView | undefined {
    const session = this.sessions.get(id);
    return session && { meta: session.meta, attached: session.sink !== null };
  }

  /** Attach a client to the session, spawning the shell first if the session does not exist. */
  async attach(id: string, sink: TerminalSink, options: TerminalAttachOptions): Promise<void> {
    const { sinceEpoch, sinceOffset } = options;
    const since =
      sinceEpoch !== undefined && sinceOffset !== undefined
        ? { epoch: sinceEpoch, offset: sinceOffset }
        : undefined;
    const scrollbackLines = options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    const running = this.sessions.get(id);
    if (running) {
      this.claim(running, sink);
      this.host.resize(id, options.cols, options.rows);
      this.host.setScrollback(id, scrollbackLines);
      // The host may still be answering the spawn; this attach then fails if the spawn does.
      await running.ready;
      return this.bind(id, running, sink, since);
    }

    const pending = this.start(id, options);
    pending.sink = sink;
    pending.size = { cols: options.cols, rows: options.rows };
    const session = await pending.session;
    if (!session) return;
    this.host.setScrollback(id, scrollbackLines);
    return this.bind(id, session, sink, since);
  }

  /**
   * Make `sink` the session's client at once, so a detach or a later attach that arrives before
   * the host is asked takes effect; nothing reaches it until its own attach's state.
   */
  private claim(session: ManagedSession, sink: TerminalSink): void {
    session.sink = sink;
    session.attachment = 0;
    session.live = false;
  }

  /**
   * Ask the host to attach `sink`, unless it was detached, the session ended, or a later attach
   * took the session over since it claimed it.
   */
  private bind(
    id: string,
    session: ManagedSession,
    sink: TerminalSink,
    since: { epoch: string; offset: number } | undefined,
  ): Promise<void> {
    if (this.sessions.get(id) !== session || session.sink !== sink) return Promise.resolve();
    const attachment = ++this.lastAttachment;
    session.attachment = attachment;
    return this.host.attach({ id, attachment, since });
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
      worktreePath: options.worktreePath ?? options.cwd,
      sink: null,
      size: null,
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
   * Start the shell in the host. The session is registered, with the client waiting for it, in the
   * same step as the host is asked, so input, resizes, attaches, detaches and a destroy that arrive meanwhile
   * go to the host after the spawn, in order. Resolves to null if the session ended meanwhile.
   */
  private async spawn(
    id: string,
    options: TerminalSpawnOptions,
    pending: PendingStart,
    env: Record<string, string | undefined>,
  ): Promise<ManagedSession | null> {
    const shell = terminalShell();
    const { cwd, windowId, command } = options;
    const { cols, rows } = pending.size ?? options;
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
      sink: pending.sink,
      attachment: 0,
      live: false,
    };
    this.sessions.set(id, session);
    try {
      await session.ready;
    } catch (err) {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      throw err;
    }
    return this.sessions.get(id) === session ? session : null;
  }

  private onHostEvent(event: TerminalHostEvent): void {
    switch (event.type) {
      case "state": {
        const session = this.sessions.get(event.state.id);
        // A state for an attach since superseded, or for a client that detached.
        if (!session?.sink || session.attachment !== event.attachment) return;
        session.live = true;
        session.sink.sendState(event.state);
        return;
      }
      case "output": {
        const session = this.sessions.get(event.id);
        if (!session?.sink || !session.live) return;
        session.sink.sendOutput(event);
        return;
      }
      case "exit": {
        const session = this.sessions.get(event.id);
        if (!session || session.epoch !== event.epoch) return;
        this.sessions.delete(event.id);
        session.sink?.sendExit(event.exitCode);
        this.hooks.onExit(event.id, event.exitCode);
        return;
      }
      case "osc": {
        const session = this.sessions.get(event.id);
        if (!session || session.epoch !== event.epoch) return;
        const { sequence, parse } = OSC_NOTIFICATIONS[event.code];
        if (!this.hooks.isSequenceEnabled(sequence)) return;
        const payload = parse(event.data);
        if (payload) this.hooks.onNotification(event.id, session.meta, payload);
        return;
      }
      default: {
        const unknownEvent: never = event;
        throw new Error(`Unknown terminal host event: ${JSON.stringify(unknownEvent)}`);
      }
    }
  }

  detach(id: string): void {
    const pending = this.starting.get(id);
    if (pending) pending.sink = null;
    const session = this.sessions.get(id);
    if (!session?.sink) return;
    session.sink = null;
    session.live = false;
    this.host.detach(id);
  }

  detachAll(ids: Iterable<string>): void {
    for (const id of ids) this.detach(id);
  }

  write(id: string, data: Uint8Array): void {
    if (this.sessions.has(id)) this.host.write(id, data);
    else this.starting.get(id)?.input.push(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.sessions.has(id)) {
      this.host.resize(id, cols, rows);
      return;
    }
    const pending = this.starting.get(id);
    if (pending) pending.size = { cols, rows };
  }

  ack(id: string, syncOffset: number, bytes: number): void {
    if (this.sessions.has(id)) this.host.ack(id, syncOffset, bytes);
  }

  destroy(id: string): void {
    this.starting.delete(id);
    if (!this.sessions.delete(id)) return;
    this.host.destroy(id);
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

  /** True if any session has no attached client. */
  hasOrphanSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.sink) return true;
    }
    return false;
  }

  /** Destroy every session without an attached client. Returns the number destroyed. */
  destroyOrphans(): number {
    const orphans = [...this.sessions].filter(([, s]) => !s.sink).map(([id]) => id);
    for (const id of orphans) this.destroy(id);
    return orphans.length;
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
