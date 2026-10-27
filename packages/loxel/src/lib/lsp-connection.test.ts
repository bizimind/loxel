import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";

import {
  LSP_EXITED_CLOSE_CODE,
  LSP_REPLACED_CLOSE_CODE,
  LSP_RESTART_CLOSE_CODE,
  LSP_START_FAILED_CLOSE_CODE,
} from "@/api/ws-protocol";

import {
  createLspConnection,
  LSP_MAX_FAILURES,
  LSP_RECONNECT_BASE_DELAY_MS,
  LSP_STABLE_CONNECTION_MS,
  type LspClose,
  type LspConnection,
  type LspConnectionState,
  type LspLink,
} from "./lsp-connection";

beforeEach(() => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

/** Advance the timers and `Date.now()` together (Bun moves the clock on some platforms only). */
function advance(ms: number): void {
  const target = new Date(Date.now() + ms);
  jest.advanceTimersByTime(ms);
  setSystemTime(target);
}

/** Let the promise callbacks of an open or a close run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

interface FakeLink {
  link: LspLink;
  disposed: boolean;
  close(code: number, reason?: string): void;
}

/** A server whose socket opens and closes when the test says so. */
class FakeServer {
  readonly opens: Array<{ wtPath: string | null; accept: () => FakeLink; refuse: () => void }> = [];
  readonly states: LspConnectionState[] = [];
  readonly connection: LspConnection;

  constructor() {
    this.connection = createLspConnection({
      open: (wtPath) =>
        new Promise((resolve, reject) => {
          this.opens.push({
            wtPath,
            accept: () => {
              const closed = Promise.withResolvers<LspClose>();
              const fake: FakeLink = {
                disposed: false,
                link: { closed: closed.promise, dispose: () => (fake.disposed = true) },
                close: (code, reason = "") => closed.resolve({ code, reason }),
              };
              resolve(fake.link);
              return fake;
            },
            refuse: () => reject(new Error("refused")),
          });
        }),
      onStateChange: (state) => this.states.push(state),
    });
  }

  /** Accept the latest open and let the connection see it. */
  async accept(): Promise<FakeLink> {
    const fake = this.opens.at(-1)!.accept();
    await settle();
    return fake;
  }

  async refuse(): Promise<void> {
    this.opens.at(-1)!.refuse();
    await settle();
  }

  get state(): LspConnectionState {
    return this.connection.state;
  }
}

async function connected(
  wtPath: string | null = "/wt",
): Promise<{ server: FakeServer; link: FakeLink }> {
  const server = new FakeServer();
  server.connection.connect(wtPath);
  const link = await server.accept();
  return { server, link };
}

async function crash(link: FakeLink): Promise<void> {
  link.close(LSP_EXITED_CLOSE_CODE, "python-lsp exited with code 1");
  await settle();
}

describe("createLspConnection", () => {
  test("disposes the client when the server exits and reconnects to the same worktree", async () => {
    const { server, link } = await connected();
    await crash(link);

    expect(link.disposed).toBe(true);
    expect(server.state).toEqual({ state: "reconnecting", delayMs: LSP_RECONNECT_BASE_DELAY_MS });
    expect(server.opens).toHaveLength(1);

    advance(LSP_RECONNECT_BASE_DELAY_MS - 1);
    expect(server.opens).toHaveLength(1);
    advance(1);
    expect(server.opens).toHaveLength(2);
    expect(server.opens[1]!.wtPath).toBe("/wt");
    await server.accept();
    expect(server.state).toEqual({ state: "connected" });
  });

  test("doubles the wait per crash in a row and stops as crashed", async () => {
    const { server, link } = await connected();
    let current = link;
    const delays: number[] = [];
    for (let failure = 1; failure < LSP_MAX_FAILURES; failure++) {
      await crash(current);
      const state = server.state;
      if (state.state !== "reconnecting") throw new Error(`unexpected ${state.state}`);
      delays.push(state.delayMs);
      advance(state.delayMs);
      current = await server.accept();
    }
    await crash(current);

    expect(delays).toEqual([1, 2, 4, 8].map((n) => n * LSP_RECONNECT_BASE_DELAY_MS));
    expect(server.state).toEqual({
      state: "stopped",
      reason: "crashed",
      detail: "python-lsp exited with code 1",
    });
    advance(10 * 60_000);
    expect(server.opens).toHaveLength(LSP_MAX_FAILURES);
  });

  test("a connection that stayed up ends the run of failures", async () => {
    const { server, link } = await connected();
    await crash(link);
    advance(LSP_RECONNECT_BASE_DELAY_MS);
    const second = await server.accept();
    await crash(second);
    expect(server.state).toEqual({
      state: "reconnecting",
      delayMs: 2 * LSP_RECONNECT_BASE_DELAY_MS,
    });

    advance(2 * LSP_RECONNECT_BASE_DELAY_MS);
    const third = await server.accept();
    advance(LSP_STABLE_CONNECTION_MS);
    await crash(third);
    expect(server.state).toEqual({ state: "reconnecting", delayMs: LSP_RECONNECT_BASE_DELAY_MS });
  });

  test("sockets that will not open stop it as unreachable", async () => {
    const server = new FakeServer();
    server.connection.connect("/wt");
    for (let failure = 1; failure < LSP_MAX_FAILURES; failure++) {
      await server.refuse();
      advance(LSP_RECONNECT_BASE_DELAY_MS * 2 ** (failure - 1));
    }
    await server.refuse();
    expect(server.state).toEqual({ state: "stopped", reason: "unreachable", detail: "" });
  });

  test("a restart close reconnects at once without counting as a failure", async () => {
    const { server, link } = await connected();
    link.close(LSP_RESTART_CLOSE_CODE);
    await settle();

    expect(link.disposed).toBe(true);
    expect(server.opens).toHaveLength(2);
    const next = await server.accept();
    await crash(next);
    expect(server.state).toEqual({ state: "reconnecting", delayMs: LSP_RECONNECT_BASE_DELAY_MS });
  });

  test("a server that cannot start stops it with the server's reason", async () => {
    const { server, link } = await connected();
    link.close(LSP_START_FAILED_CLOSE_CODE, "python-lsp failed to start");
    await settle();

    expect(server.state).toEqual({
      state: "stopped",
      reason: "start-failed",
      detail: "python-lsp failed to start",
    });
    advance(10 * 60_000);
    expect(server.opens).toHaveLength(1);
  });

  test("replaced by another window: stays stopped until restarted, so windows never ping-pong", async () => {
    const { server, link } = await connected();
    link.close(LSP_REPLACED_CLOSE_CODE, "Replaced by newer connection");
    await settle();

    expect(link.disposed).toBe(true);
    expect(server.state).toMatchObject({ state: "stopped", reason: "replaced" });
    advance(10 * 60_000);
    server.connection.resume();
    server.connection.connect("/wt");
    expect(server.opens).toHaveLength(1);

    server.connection.restart();
    expect(server.opens).toHaveLength(2);
    await server.accept();
    expect(server.state).toEqual({ state: "connected" });
  });

  test("resume reconnects at once while waiting, and with a fresh count once stopped", async () => {
    const { server, link } = await connected();
    await crash(link);
    server.connection.resume();
    expect(server.opens).toHaveLength(2);
    await server.refuse();
    expect(server.state).toEqual({ state: "reconnecting", delayMs: LSP_RECONNECT_BASE_DELAY_MS });

    for (let failure = 1; failure < LSP_MAX_FAILURES; failure++) {
      advance(LSP_RECONNECT_BASE_DELAY_MS * 2 ** (failure - 1));
      await server.refuse();
    }
    // One open per failure: the timer that was waiting when resumed never fired.
    expect(server.opens).toHaveLength(1 + LSP_MAX_FAILURES);
    expect(server.state).toMatchObject({ state: "stopped", reason: "unreachable" });

    server.connection.resume();
    await server.refuse();
    expect(server.state).toEqual({ state: "reconnecting", delayMs: LSP_RECONNECT_BASE_DELAY_MS });
  });

  test("resume leaves a live connection alone", async () => {
    const { server, link } = await connected();
    server.connection.resume();
    expect(server.opens).toHaveLength(1);
    expect(link.disposed).toBe(false);
  });

  test("disconnect cancels a pending reconnect and disposes a socket that opens late", async () => {
    const { server, link } = await connected();
    await crash(link);
    server.connection.disconnect();
    advance(10 * 60_000);
    expect(server.opens).toHaveLength(1);
    expect(server.state).toEqual({ state: "idle" });

    server.connection.connect("/wt");
    server.connection.disconnect();
    const late = await server.accept();
    expect(late.disposed).toBe(true);
    expect(server.state).toEqual({ state: "idle" });
  });

  test("connect is a no-op for the same worktree and replaces the link for another", async () => {
    const { server, link } = await connected("/a");
    server.connection.connect("/a");
    expect(server.opens).toHaveLength(1);

    server.connection.connect("/b");
    expect(link.disposed).toBe(true);
    expect(server.opens[1]!.wtPath).toBe("/b");
    // The old socket closing (the client closed it) does not reconnect anything.
    link.close(1000);
    await settle();
    expect(server.opens).toHaveLength(2);
  });
});
