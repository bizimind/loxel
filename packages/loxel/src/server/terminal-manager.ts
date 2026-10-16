/**
 * Terminal sessions keyed by the client-generated terminal ID. Spawns the shell on first attach,
 * tracks orphaned sessions, and owns the shell environment. See docs/TERMINALS.md.
 */
import type { NotificationSequence } from "@/api/ws-protocol";
import type { OscPayload } from "@/lib/osc-notification-parser";

import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";
import type { TerminalSink } from "./terminal-session";
import { TerminalSession } from "./terminal-session";

const log = logger.child("terminal");
const textEncoder = new TextEncoder();

/** How long a command registered for a terminal waits for its panel to attach before it is dropped. */
const INITIAL_COMMAND_TTL_MS = 60_000;

export interface TerminalAttachOptions {
  cols: number;
  rows: number;
  /** Applied only when the session is spawned. */
  cwd: string;
  /** The panel's worktree when the shell starts elsewhere; applied only when spawned. */
  worktreePath?: string;
  /** Applied only when the session is spawned. */
  envOverrides?: Record<string, string>;
  scrollbackLines?: number;
  /** Session epoch and stream offset the client is already current to; see `terminal_attach`. */
  sinceEpoch?: string;
  sinceOffset?: number;
}

export interface TerminalManagerHooks {
  isSequenceEnabled: (sequence: NotificationSequence) => boolean;
  onNotification: (session: TerminalSession, payload: OscPayload) => void;
  /** Called after the session has been removed. */
  onExit: (session: TerminalSession, exitCode: number) => void;
}

/** Build terminal-specific env: login shell PATH + TERM fallback. */
function buildTerminalEnv(): Record<string, string | undefined> {
  const env = buildSpawnEnv();
  if (!env.TERM) env.TERM = "xterm-256color";
  return env;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private initialCommands = new Map<
    string,
    { command: string; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly hooks: TerminalManagerHooks,
    private readonly initialCommandTtlMs = INITIAL_COMMAND_TTL_MS,
  ) {}

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Type `command` into the shell of terminal `id` once it is spawned, as if the user had entered
   * it. One-shot: the first spawn consumes it, and it is dropped if no panel attaches within
   * {@link INITIAL_COMMAND_TTL_MS}, so a later respawn under the same ID (server restart, reload)
   * gets a plain shell and never re-runs the command.
   */
  setInitialCommand(id: string, command: string): void {
    this.clearInitialCommand(id);
    const timer = setTimeout(() => {
      this.initialCommands.delete(id);
      log.warn(`Dropping initial command for terminal ${id.slice(0, 8)}: no panel attached`);
    }, this.initialCommandTtlMs);
    this.initialCommands.set(id, { command, timer });
  }

  /** Forget a command registered with {@link setInitialCommand}; no-op if none is pending. */
  clearInitialCommand(id: string): void {
    const pending = this.initialCommands.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.initialCommands.delete(id);
  }

  private takeInitialCommand(id: string): string | null {
    const pending = this.initialCommands.get(id);
    if (!pending) return null;
    this.clearInitialCommand(id);
    return pending.command;
  }

  /** Attach a client to the session, spawning the shell first if the session does not exist. */
  async attach(id: string, sink: TerminalSink, options: TerminalAttachOptions): Promise<void> {
    let session = this.sessions.get(id);
    if (session) {
      session.resize(options.cols, options.rows);
      session.setScrollbackLines(options.scrollbackLines);
    } else {
      session = this.spawn(id, options);
    }
    return session.attach(sink, { epoch: options.sinceEpoch, offset: options.sinceOffset });
  }

  private spawn(id: string, options: TerminalAttachOptions): TerminalSession {
    const shell = process.env.SHELL || "/bin/bash";
    const { cols, rows, cwd, worktreePath } = options;
    log.info(`Spawning terminal ${id.slice(0, 8)} with ${shell} (${cols}x${rows}) in ${cwd}`);

    const env = buildTerminalEnv();
    if (options.envOverrides) Object.assign(env, options.envOverrides);

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
    const command = this.takeInitialCommand(id);
    if (command !== null) session.write(textEncoder.encode(`${command}\n`));
    return session;
  }

  detach(id: string): void {
    this.sessions.get(id)?.detach();
  }

  detachAll(ids: Iterable<string>): void {
    for (const id of ids) this.detach(id);
  }

  write(id: string, data: Uint8Array): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows);
  }

  ack(id: string, syncOffset: number, bytes: number): void {
    this.sessions.get(id)?.ack(syncOffset, bytes);
  }

  destroy(id: string): void {
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
    for (const id of [...this.sessions.keys()]) this.destroy(id);
    for (const id of [...this.initialCommands.keys()]) this.clearInitialCommand(id);
  }
}
