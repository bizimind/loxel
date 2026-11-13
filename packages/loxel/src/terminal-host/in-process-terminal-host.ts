/**
 * A {@link TerminalHost} that runs its sessions in the calling process. Events are delivered
 * synchronously, from the PTY's callbacks or the call that caused them. See docs/TERMINAL_HOST.md.
 */
import type {
  TerminalAttachRequest,
  TerminalHost,
  TerminalHostEvent,
  TerminalSessionInfo,
  TerminalSessionMeta,
  TerminalSpawnRequest,
} from "./terminal-host";
import type { TerminalSessionRuntime } from "./terminal-session";
import { TerminalSession } from "./terminal-session";

interface HostedSession {
  session: TerminalSession;
  meta: TerminalSessionMeta;
}

export class InProcessTerminalHost implements TerminalHost {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly listeners = new Set<(event: TerminalHostEvent) => void>();

  constructor(private readonly runtime: TerminalSessionRuntime) {}

  spawn(request: TerminalSpawnRequest): Promise<TerminalSessionInfo> {
    const { id, meta, input } = request;
    if (this.sessions.has(id)) {
      return Promise.reject(new Error(`Terminal ${id} is already running`));
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
    const hosted = { session, meta };
    this.sessions.set(id, hosted);
    if (input && input.byteLength > 0) session.write(input);
    return Promise.resolve(this.info(hosted));
  }

  list(): Promise<TerminalSessionInfo[]> {
    return Promise.resolve([...this.sessions.values()].map((hosted) => this.info(hosted)));
  }

  async attach(request: TerminalAttachRequest): Promise<void> {
    await this.sessions.get(request.id)?.session.attach(request.attachment, request.since);
  }

  detach(id: string): void {
    this.sessions.get(id)?.session.detach();
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
    this.sessions.get(id)?.session.ack(syncOffset, bytes);
  }

  destroy(id: string): void {
    const hosted = this.sessions.get(id);
    if (!hosted) return;
    this.sessions.delete(id);
    hosted.session.destroy();
  }

  setMeta(id: string, meta: TerminalSessionMeta): void {
    const hosted = this.sessions.get(id);
    if (hosted) hosted.meta = meta;
  }

  /** The IDs of the running sessions, for the host process's own bookkeeping. */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
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
    if (this.sessions.get(session.id)?.session !== session) return;
    this.sessions.delete(session.id);
    session.destroy();
    this.emit({ type: "exit", id: session.id, epoch: session.epoch, exitCode });
  }
}
