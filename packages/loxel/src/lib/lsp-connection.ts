import {
  LSP_EXITED_CLOSE_CODE,
  LSP_REPLACED_CLOSE_CODE,
  LSP_RESTART_CLOSE_CODE,
  LSP_START_FAILED_CLOSE_CODE,
} from "@/api/ws-protocol";

/** Wait before the first reconnect after a failure; it doubles with each failure in a row. */
export const LSP_RECONNECT_BASE_DELAY_MS = 1_000;
/** Failures in a row (closes and sockets that would not open) after which reconnecting stops. */
export const LSP_MAX_FAILURES = 5;
/** A connection that stayed up this long ends a run of failures: its close starts a new one. */
export const LSP_STABLE_CONNECTION_MS = 60_000;

/** How a language-server socket closed. */
export interface LspClose {
  code: number;
  reason: string;
}

/** One open socket with a client on it. */
export interface LspLink {
  /** Settles once the socket closes, from either side. */
  readonly closed: Promise<LspClose>;
  /** Dispose the client (its providers and markers go away), then the socket. */
  dispose(): void;
}

/**
 * Why a connection stopped reconnecting:
 * - `crashed`: the server kept exiting on its own.
 * - `unreachable`: the socket kept closing or would not open (Loxel's server is gone).
 * - `start-failed`: the server could not start (no binary, or it cannot be executed).
 * - `replaced`: another window on the same worktree took the server over.
 */
export type LspStopReason = "crashed" | "unreachable" | "start-failed" | "replaced";

export type LspConnectionState =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "reconnecting"; delayMs: number }
  | { state: "stopped"; reason: LspStopReason; detail: string };

export interface LspConnectionOptions {
  /** Open the socket for the worktree (null: a server not scoped to one); rejects when it cannot. */
  open(wtPath: string | null): Promise<LspLink>;
  onStateChange(state: LspConnectionState): void;
}

export interface LspConnection {
  /** Connect to `wtPath`'s server. A no-op while already connected (or stopped) for that path. */
  connect: (wtPath: string | null) => void;
  disconnect: () => void;
  /** Connect again from scratch, whatever the state, with a fresh failure count. */
  restart: () => void;
  /**
   * Loxel's server is reachable again: reconnect now, with a fresh failure count, if the
   * connection is waiting to reconnect or stopped for any reason but `replaced`.
   */
  resume: () => void;
  readonly state: LspConnectionState;
}

/**
 * The reconnect policy of a language-server client. Every close tears the client down, so its
 * stale providers and diagnostics go away; then, by close code:
 * - {@link LSP_RESTART_CLOSE_CODE}: reconnect at once (Loxel restarts the server on purpose).
 * - {@link LSP_EXITED_CLOSE_CODE}, any other code, or a socket that would not open: reconnect
 *   after {@link LSP_RECONNECT_BASE_DELAY_MS}, doubling per failure in a row, and stop after
 *   {@link LSP_MAX_FAILURES}. A connection that stayed up {@link LSP_STABLE_CONNECTION_MS} ends the
 *   run, so a server that crashes now and then always comes back.
 * - {@link LSP_START_FAILED_CLOSE_CODE}: stop, since starting again would fail the same way.
 * - {@link LSP_REPLACED_CLOSE_CODE}: stop. Another window opened the same worktree's server, and
 *   taking it back would make that window take it back in turn, forever. The user moves it back
 *   with {@link LspConnection.restart}.
 */
export function createLspConnection(options: LspConnectionOptions): LspConnection {
  let target: { wtPath: string | null } | null = null;
  let link: LspLink | null = null;
  /** Bumped on every teardown, so a stale open or close is ignored. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let state: LspConnectionState = { state: "idle" };

  function setState(next: LspConnectionState): void {
    state = next;
    options.onStateChange(next);
  }

  function release(): void {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    link?.dispose();
    link = null;
  }

  function attempt(wtPath: string | null): void {
    release();
    const gen = generation;
    setState({ state: "connecting" });
    options.open(wtPath).then(
      (opened) => {
        if (gen !== generation) {
          opened.dispose();
          return;
        }
        link = opened;
        const openedAt = Date.now();
        setState({ state: "connected" });
        void opened.closed.then((close) => {
          if (gen !== generation) return;
          link = null;
          opened.dispose();
          handleClose(wtPath, close, Date.now() - openedAt);
        });
      },
      () => {
        if (gen === generation) handleClose(wtPath, null, 0);
      },
    );
  }

  function stop(reason: LspStopReason, detail: string): void {
    release();
    setState({ state: "stopped", reason, detail });
  }

  /** `close` is null for a socket that would not open. */
  function handleClose(wtPath: string | null, close: LspClose | null, lifetimeMs: number): void {
    const detail = close?.reason ?? "";
    const code = close?.code;
    if (code === LSP_RESTART_CLOSE_CODE) {
      attempt(wtPath);
      return;
    }
    if (code === LSP_REPLACED_CLOSE_CODE) {
      stop("replaced", detail);
      return;
    }
    if (code === LSP_START_FAILED_CLOSE_CODE) {
      stop("start-failed", detail);
      return;
    }
    if (lifetimeMs >= LSP_STABLE_CONNECTION_MS) failures = 0;
    failures += 1;
    if (failures >= LSP_MAX_FAILURES) {
      stop(code === LSP_EXITED_CLOSE_CODE ? "crashed" : "unreachable", detail);
      return;
    }
    const delayMs = LSP_RECONNECT_BASE_DELAY_MS * 2 ** (failures - 1);
    timer = setTimeout(() => attempt(wtPath), delayMs);
    setState({ state: "reconnecting", delayMs });
  }

  return {
    connect: (wtPath) => {
      if (target?.wtPath === wtPath) return;
      target = { wtPath };
      failures = 0;
      attempt(wtPath);
    },
    disconnect: () => {
      target = null;
      release();
      if (state.state !== "idle") setState({ state: "idle" });
    },
    restart: () => {
      if (!target) return;
      failures = 0;
      attempt(target.wtPath);
    },
    resume: () => {
      if (!target) return;
      const waiting = state.state === "reconnecting";
      const stopped = state.state === "stopped" && state.reason !== "replaced";
      if (!waiting && !stopped) return;
      failures = 0;
      attempt(target.wtPath);
    },
    get state() {
      return state;
    },
  };
}
