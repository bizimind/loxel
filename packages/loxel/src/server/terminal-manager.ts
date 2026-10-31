/**
 * Terminal sessions keyed by the terminal ID. Spawns the shell on first attach (or up front for
 * `loxel terminal`), tracks orphaned sessions, and owns the shell environment. See
 * docs/TERMINALS.md.
 */
import type { NotificationSequence } from "@/api/ws-protocol";
import { CODING_AGENT_ENV_VARS } from "@/coding-agent-env";
import type { OscPayload } from "@/lib/osc-notification-parser";

import { logger } from "./logger";
import { buildShellSpawnEnv } from "./shell-env";
import type { TerminalSink } from "./terminal-session";
import { TerminalSession } from "./terminal-session";
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

export interface TerminalSpawnOptions extends TerminalToolchainSettings {
  cols: number;
  rows: number;
  /** Applied only when the session is spawned. */
  cwd: string;
  /** The panel's worktree when the shell starts elsewhere; applied only when spawned. */
  worktreePath?: string;
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
  onNotification: (session: TerminalSession, payload: OscPayload) => void;
  /** Called after the session has been removed. */
  onExit: (session: TerminalSession, exitCode: number) => void;
  /** What contributes to a new shell's environment, applied in this order. */
  toolchainEnvs: readonly ToolchainEnvContributor[];
}

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
  /** Resolves to null when the terminal was destroyed meanwhile. */
  session: Promise<TerminalSession | null>;
  /** The client to bind once spawned; cleared by a detach. */
  sink: TerminalSink | null;
  /** The latest size an attach or resize asked for. */
  size: { cols: number; rows: number } | null;
  /** Keystrokes sent before the shell existed, written to it in order once it does. */
  input: Uint8Array[];
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private starting = new Map<string, PendingStart>();

  constructor(private readonly hooks: TerminalManagerHooks) {}

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** Attach a client to the session, spawning the shell first if the session does not exist. */
  async attach(id: string, sink: TerminalSink, options: TerminalAttachOptions): Promise<void> {
    const running = this.sessions.get(id);
    const since = { epoch: options.sinceEpoch, offset: options.sinceOffset };
    if (running) {
      running.resize(options.cols, options.rows);
      running.setScrollbackLines(options.scrollbackLines);
      return running.attach(sink, since);
    }

    const pending = this.start(id, options);
    pending.sink = sink;
    pending.size = { cols: options.cols, rows: options.rows };
    const session = await pending.session;
    // Destroyed, detached, or taken over by a later attach while the environment was resolved.
    if (!session || pending.sink !== sink) return;
    session.setScrollbackLines(options.scrollbackLines);
    return session.attach(sink, since);
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
        const session = this.spawn(id, options, env);
        if (pending.size) session.resize(pending.size.cols, pending.size.rows);
        for (const data of pending.input) session.write(data);
        return session;
      }),
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

  private spawn(
    id: string,
    options: TerminalSpawnOptions,
    env: Record<string, string | undefined>,
  ): TerminalSession {
    const shell = terminalShell();
    const { cols, rows, cwd, worktreePath, command } = options;
    log.info(`Spawning terminal ${id.slice(0, 8)} with ${shell} (${cols}x${rows}) in ${cwd}`);

    const session = new TerminalSession({
      id,
      cols,
      rows,
      cwd,
      worktreePath,
      scrollbackLines: options.scrollbackLines,
      env,
      command: [shell, "-il"],
      isSequenceEnabled: this.hooks.isSequenceEnabled,
      onNotification: this.hooks.onNotification,
      onExit: (exited, exitCode) => {
        // A session destroyed on purpose exits a little later; by then its ID may already belong
        // to a fresh spawn (a respawn after destroy), which must not be dropped in its place.
        if (this.sessions.get(id) !== exited) return;
        this.sessions.delete(id);
        exited.destroy();
        this.hooks.onExit(exited, exitCode);
      },
    });
    this.sessions.set(id, session);

    // Typed ahead: the PTY queues the bytes until the shell reads its first line, so the command
    // shows up at the prompt and in shell history exactly as if the user had entered it.
    if (command !== undefined) session.write(textEncoder.encode(`${command}\n`));
    return session;
  }

  detach(id: string): void {
    const pending = this.starting.get(id);
    if (pending) pending.sink = null;
    this.sessions.get(id)?.detach();
  }

  detachAll(ids: Iterable<string>): void {
    for (const id of ids) this.detach(id);
  }

  write(id: string, data: Uint8Array): void {
    const session = this.sessions.get(id);
    if (session) session.write(data);
    else this.starting.get(id)?.input.push(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.resize(cols, rows);
      return;
    }
    const pending = this.starting.get(id);
    if (pending) pending.size = { cols, rows };
  }

  ack(id: string, syncOffset: number, bytes: number): void {
    this.sessions.get(id)?.ack(syncOffset, bytes);
  }

  destroy(id: string): void {
    this.starting.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.destroy();
  }

  /** True if any session has no attached client. */
  hasOrphanSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.attached) return true;
    }
    return false;
  }

  /** Destroy every session without an attached client. Returns the number destroyed. */
  destroyOrphans(): number {
    const orphans = [...this.sessions.values()].filter((s) => !s.attached);
    for (const session of orphans) this.destroy(session.id);
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
