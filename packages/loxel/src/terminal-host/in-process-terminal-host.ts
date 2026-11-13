/**
 * A {@link TerminalHost} that runs its sessions in the calling process. Events are delivered
 * synchronously, from the PTY's callbacks or the call that caused them. See docs/TERMINAL_HOST.md.
 */
import { foregroundPrograms } from "./foreground-process";
import type {
  ForegroundProcesses,
  TerminalAttachRequest,
  TerminalHost,
  TerminalHostEvent,
  TerminalSessionEnd,
  TerminalSessionInfo,
  TerminalSessionMeta,
  TerminalSpawnRequest,
} from "./terminal-host";
import type { TerminalSessionRuntime } from "./terminal-session";
import { TerminalSession } from "./terminal-session";

interface HostedSession {
  session: TerminalSession;
  meta: TerminalSessionMeta;
  /** The program the session spawned, `argv[0]`. */
  program: string;
}

/** A session whose program ended while ended sessions were kept, until it is attached or destroyed. */
interface EndedSession {
  /** As listed, with how it ended. */
  info: TerminalSessionInfo & { ended: TerminalSessionEnd };
  /** Its ring and screen; null once let go to stay within the limits, when an attach only gets the exit. */
  session: TerminalSession | null;
}

/**
 * How much ended sessions may hold. Past `withOutput` sessions or `outputBytes` of their rings,
 * the oldest let go of their output and screen; past `sessions`, the oldest is dropped altogether.
 * No session is spawned while no server is connected, so ended sessions never hold more than they
 * did running: the limits bound what piles up across servers that never attach to them.
 */
export interface EndedSessionLimits {
  sessions: number;
  withOutput: number;
  outputBytes: number;
}

export const ENDED_SESSION_LIMITS: EndedSessionLimits = {
  sessions: 1000,
  withOutput: 128,
  outputBytes: 128 * 1024 * 1024,
};

export class InProcessTerminalHost implements TerminalHost {
  private readonly sessions = new Map<string, HostedSession>();
  /** Oldest first. */
  private readonly ended = new Map<string, EndedSession>();
  private readonly listeners = new Set<(event: TerminalHostEvent) => void>();
  /** Set while ended sessions are kept: called after each session that ended so. */
  private onKeptEnded: (() => void) | null = null;

  constructor(
    private readonly runtime: TerminalSessionRuntime,
    private readonly endedLimits: EndedSessionLimits = ENDED_SESSION_LIMITS,
  ) {}

  spawn(request: TerminalSpawnRequest): Promise<TerminalSessionInfo> {
    const { id, meta, input } = request;
    if (this.sessions.has(id) || this.ended.has(id)) {
      const state = this.sessions.has(id) ? "running" : "kept, ended";
      return Promise.reject(new Error(`Terminal ${id} is already ${state}`));
    }
    let session: TerminalSession;
    try {
      session = new TerminalSession({
        id,
        epoch: request.epoch,
        argv: request.argv,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
        scrollbackLines: request.scrollbackLines,
        runtime: this.runtime,
        emit: (event) => this.emit(event),
        onExit: (exitCode) => this.onSessionExit(session, exitCode),
      });
    } catch (err) {
      return Promise.reject(new Error(`Could not start terminal ${id}`, { cause: err }));
    }
    // Registered before returning, so commands sent right after spawn() reach this session.
    const hosted = { session, meta, program: request.argv[0]! };
    this.sessions.set(id, hosted);
    if (input && input.byteLength > 0) session.write(input);
    return Promise.resolve(this.info(hosted));
  }

  list(): Promise<TerminalSessionInfo[]> {
    const running = [...this.sessions.values()].map((hosted) => this.info(hosted));
    const ended = [...this.ended.values()].map(({ info }) => info);
    return Promise.resolve([...running, ...ended]);
  }

  async attach(request: TerminalAttachRequest): Promise<void> {
    const { id, attachment, since } = request;
    const hosted = this.sessions.get(id);
    if (hosted) {
      await hosted.session.attach(attachment, since);
      return;
    }
    const ended = this.ended.get(id);
    if (!ended) return;
    const { session } = ended;
    if (session) {
      // The state and the output the client missed, then the exit.
      const current = await session.attach(attachment, since);
      // Superseded meanwhile by another attach (even one re-sent with the same number after a
      // reconnect) or a detach, which decides instead. One whose output was let go of meanwhile
      // has nothing left to show, only the exit.
      if (ended.session === session && !current) return;
    }
    // Forgotten meanwhile, or already reported by an attach that superseded this one; or its server
    // left meanwhile, and the exit waits for the next one.
    if (this.ended.get(id) !== ended || this.onKeptEnded) return;
    this.reportEnded(ended);
  }

  detach(id: string): void {
    (this.sessions.get(id)?.session ?? this.ended.get(id)?.session)?.detach();
  }

  write(id: string, data: Uint8Array): void {
    this.sessions.get(id)?.session.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.session.resize(cols, rows);
  }

  setScrollback(id: string, lines: number): void {
    this.sessions.get(id)?.session.setScrollbackLines(lines);
  }

  ack(id: string, syncOffset: number, bytes: number): void {
    (this.sessions.get(id)?.session ?? this.ended.get(id)?.session)?.ack(syncOffset, bytes);
  }

  destroy(id: string): void {
    const ended = this.ended.get(id);
    if (ended) {
      this.ended.delete(id);
      ended.session?.destroy();
      return;
    }
    const hosted = this.sessions.get(id);
    if (!hosted) return;
    this.sessions.delete(id);
    hosted.session.destroy();
  }

  setMeta(id: string, meta: TerminalSessionMeta): void {
    const hosted = this.sessions.get(id);
    if (hosted) hosted.meta = meta;
    const ended = this.ended.get(id);
    if (ended) ended.info = { ...ended.info, meta };
  }

  async foregroundProcesses(): Promise<ForegroundProcesses> {
    const hosted = [...this.sessions.values()];
    const programs = await foregroundPrograms(
      hosted.map(({ session, program }) => ({ pid: session.pid, program })),
    );
    const result: ForegroundProcesses = {};
    for (const { session } of hosted) {
      const program = programs.get(session.pid);
      // Ended meanwhile, or its program could not be named.
      if (program !== undefined && this.sessions.get(session.id)?.session === session) {
        result[session.id] = program;
      }
    }
    return result;
  }

  /** The IDs of the running sessions, for the host process's own bookkeeping. */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** How many ended sessions are kept, until attached or destroyed. */
  get endedSessionCount(): number {
    return this.ended.size;
  }

  /** Detach every session's client, ended sessions' included. */
  detachAll(): void {
    for (const id of [...this.sessions.keys(), ...this.ended.keys()]) this.detach(id);
  }

  /** End every session and forget every ended one. */
  destroyAll(): void {
    for (const id of [...this.sessions.keys(), ...this.ended.keys()]) this.destroy(id);
  }

  /**
   * From now on, keep a session whose program ends instead of reporting its exit: it is listed
   * with its exit code, the next attach gets what the client missed and then the exit, and
   * `destroy` forgets it. The host process does this while no server is connected, so the next one
   * learns what such a session did. `onEnded` runs after each session that ended so.
   */
  keepEndedSessions(onEnded: () => void): void {
    this.onKeptEnded = onEnded;
  }

  /** Report exits again. Sessions that ended meanwhile stay until attached or destroyed. */
  stopKeepingEndedSessions(): void {
    this.onKeptEnded = null;
  }

  /** Forget every ended session, for a server that does not know of them. */
  forgetEndedSessions(): void {
    for (const id of [...this.ended.keys()]) this.destroy(id);
  }

  onEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private info({ session, meta }: HostedSession): TerminalSessionInfo {
    const { id, epoch, pid, outputOffset: offset, cols, rows } = session;
    return { id, epoch, offset, pid, cols, rows, meta };
  }

  private emit(event: TerminalHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private onSessionExit(session: TerminalSession, exitCode: number): void {
    // A destroyed session exits a little later; by then its ID may already belong to a fresh
    // spawn, which must not be dropped in its place.
    const hosted = this.sessions.get(session.id);
    if (hosted?.session !== session) return;
    this.sessions.delete(session.id);
    const onEnded = this.onKeptEnded;
    if (!onEnded) {
      session.destroy();
      this.emit({ type: "exit", id: session.id, epoch: session.epoch, exitCode });
      return;
    }
    session.hangUp();
    this.runtime.log.info(`Keeping terminal ${session.id.slice(0, 8)}, ended with no server`);
    const ended = { exitCode, outputKept: true };
    this.ended.set(session.id, { info: { ...this.info(hosted), ended }, session });
    this.enforceEndedLimits();
    onEnded();
  }

  /** Report an ended session's exit, now that its client has what it missed, and forget it. */
  private reportEnded({ info, session }: EndedSession): void {
    this.ended.delete(info.id);
    session?.destroy();
    this.emit({ type: "exit", id: info.id, epoch: info.epoch, exitCode: info.ended.exitCode });
  }

  private enforceEndedLimits(): void {
    const { log } = this.runtime;
    for (const ended of this.ended.values()) {
      if (this.ended.size <= this.endedLimits.sessions) break;
      log.warn(`Too many ended terminals; forgetting ${ended.info.id.slice(0, 8)} and its exit`);
      this.destroy(ended.info.id);
    }
    const withOutput = [...this.ended.values()].flatMap((ended) =>
      ended.session ? [{ ended, session: ended.session }] : [],
    );
    let bytes = withOutput.reduce((sum, { session }) => sum + session.retainedBytes, 0);
    let count = withOutput.length;
    for (const { ended, session } of withOutput) {
      if (count <= this.endedLimits.withOutput && bytes <= this.endedLimits.outputBytes) break;
      log.info(`Letting go of the output of ended terminal ${ended.info.id.slice(0, 8)}`);
      bytes -= session.retainedBytes;
      count--;
      session.destroy();
      ended.session = null;
      ended.info = { ...ended.info, ended: { ...ended.info.ended, outputKept: false } };
    }
  }
}
