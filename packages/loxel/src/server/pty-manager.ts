/**
 * PTY session management for loxel terminal panels.
 * Adapted from packages/remote-terminal/src/pty.ts.
 */
import type { Subprocess } from "bun";

import { DEFAULT_SCROLLBACK_LINES } from "@/api/ws-protocol";

import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";
import { stress } from "./stress-detector";

const log = logger.child("terminal");

/** Estimated bytes per terminal line for server-side buffer sizing. */
const BYTES_PER_LINE = 100;

interface PtySession {
  id: string;
  proc: Subprocess;
  cols: number;
  rows: number;
  /** Mutable callback — null when detached (no owning client). */
  onOutput: ((id: string, data: Uint8Array) => void) | null;
  /** Mutable callback — null when detached (no owning client). */
  onExit: ((id: string, exitCode: number) => void) | null;
  /** Circular buffer of recent PTY output for replay on reattach. */
  scrollback: Uint8Array[];
  /** Total bytes in scrollback. */
  scrollbackSize: number;
  /** Per-session max scrollback bytes, derived from client scrollback lines. */
  maxScrollback: number;
}

/** Build terminal-specific env: login shell PATH + TERM fallback. */
function buildTerminalEnv(): Record<string, string | undefined> {
  const env = buildSpawnEnv();
  if (!env.TERM) env.TERM = "xterm-256color";
  return env;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  create(
    id: string,
    options: {
      cols: number;
      rows: number;
      cwd: string;
      scrollbackLines?: number;
      envOverrides?: Record<string, string>;
    },
    onOutput: (id: string, data: Uint8Array) => void,
    onExit: (id: string, exitCode: number) => void,
  ): void {
    // If session already exists (reattach after layout swap), update callbacks and replay scrollback
    const existing = this.sessions.get(id);
    if (existing) {
      log.info(
        `Reattaching terminal ${id.slice(0, 8)} (${existing.scrollbackSize} bytes scrollback)`,
      );
      existing.onOutput = onOutput;
      existing.onExit = onExit;

      // Replay scrollback so the new xterm.js instance shows previous output
      for (const chunk of existing.scrollback) {
        onOutput(id, chunk);
      }
      return;
    }

    const shell = process.env.SHELL || "/bin/bash";
    const { cols, rows, cwd } = options;
    const clampedLines = Math.max(
      1_000,
      Math.min(100_000, options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES),
    );
    const maxScrollback = clampedLines * BYTES_PER_LINE;

    log.info(`Spawning terminal ${id.slice(0, 8)} with ${shell} (${cols}x${rows}) in ${cwd}`);

    const session: PtySession = {
      id,
      proc: null!,
      cols,
      rows,
      onOutput,
      onExit,
      scrollback: [],
      scrollbackSize: 0,
      maxScrollback,
    };

    const env = buildTerminalEnv();
    if (options.envOverrides) Object.assign(env, options.envOverrides);

    const proc = Bun.spawn([shell, "-il"], {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        data: (_term, data) => {
          // Store in scrollback buffer
          session.scrollback.push(new Uint8Array(data));
          session.scrollbackSize += data.byteLength;

          // Evict old chunks if buffer exceeds max
          while (session.scrollbackSize > session.maxScrollback && session.scrollback.length > 1) {
            const evicted = session.scrollback.shift()!;
            session.scrollbackSize -= evicted.byteLength;
          }

          // Delegate through session's mutable callback (null when detached)
          stress.track("pty-output");
          session.onOutput?.(id, data);
        },
      },
    });

    session.proc = proc;
    this.sessions.set(id, session);

    // Fire-and-forget: wait for process exit
    proc.exited.then((exitCode) => {
      log.info(`Terminal ${id.slice(0, 8)} exited with code ${exitCode}`);
      this.sessions.delete(id);
      session.onExit?.(id, exitCode);
    });
  }

  /** Write binary data from client directly to PTY stdin. */
  writeBinary(id: string, data: Uint8Array): void {
    const session = this.sessions.get(id);
    if (session) {
      // Bun's terminal.write accepts string; decode the input bytes
      session.proc.terminal?.write(new TextDecoder().decode(data));
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.proc.terminal?.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    }
  }

  /** Detach a terminal from its owning client. Session stays alive for reattach. */
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    log.debug(`Detaching terminal ${id.slice(0, 8)}`);
    session.onOutput = null;
    session.onExit = null;
  }

  /** Detach all terminals matching the given IDs. */
  detachAll(ids: Iterable<string>): void {
    for (const id of ids) {
      this.detach(id);
    }
  }

  /** Returns true if any sessions exist without callbacks (detached/orphaned). */
  hasOrphanSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.onOutput) return true;
    }
    return false;
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    log.debug(`Destroying terminal ${id.slice(0, 8)}`);
    this.sessions.delete(id);
    try {
      session.proc.terminal?.close();
      session.proc.kill();
    } catch {
      // Process may already be dead
    }
  }

  /** Destroy all detached (ownerless) sessions. Returns the number destroyed. */
  destroyOrphans(): number {
    const orphanIds = [...this.sessions.values()].filter((s) => !s.onOutput).map((s) => s.id);
    for (const id of orphanIds) {
      this.destroy(id);
    }
    return orphanIds.length;
  }

  destroyAll(): void {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      this.destroy(id);
    }
  }
}
