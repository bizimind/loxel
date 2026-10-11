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

export interface TerminalAttachOptions {
  cols: number;
  rows: number;
  /** Applied only when the session is spawned. */
  cwd: string;
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

  constructor(private readonly hooks: TerminalManagerHooks) {}

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** Attach a client to the session, spawning the shell first if the session does not exist. */
  attach(id: string, sink: TerminalSink, options: TerminalAttachOptions): Promise<void> {
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
    const { cols, rows, cwd } = options;
    log.info(`Spawning terminal ${id.slice(0, 8)} with ${shell} (${cols}x${rows}) in ${cwd}`);

    const env = buildTerminalEnv();
    if (options.envOverrides) Object.assign(env, options.envOverrides);

    const session = new TerminalSession({
      id,
      cols,
      rows,
      cwd,
      scrollbackLines: options.scrollbackLines,
      env,
      command: [shell, "-il"],
      isSequenceEnabled: this.hooks.isSequenceEnabled,
      onNotification: this.hooks.onNotification,
      onExit: (exited, exitCode) => {
        this.sessions.delete(id);
        exited.destroy();
        this.hooks.onExit(exited, exitCode);
      },
    });
    this.sessions.set(id, session);
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
  }
}
