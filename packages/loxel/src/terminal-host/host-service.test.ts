import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { until } from "@/test/until";

import { TERMINAL_HOST_GRACE_MS, TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import { TERMINAL_HOST_PROTOCOL } from "./protocol";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startService() {
  const dir = mkdtempSync(join(tmpdir(), "ths-"));
  const socketPath = join(dir, "host.sock");
  const host = new InProcessTerminalHost({ log: createNoopLogger() });
  const done: string[] = [];
  const forwarding: boolean[] = [];
  let onForwarding: (() => void) | null = null;
  /** Resolves when the host next starts (true) or stops (false) forwarding its log to a server. */
  const forwardingChanged = () =>
    new Promise<boolean>((resolve) => {
      onForwarding = () => resolve(forwarding.at(-1)!);
    });
  const service = new TerminalHostService({
    host,
    hostBuildId: "build-a",
    log: createNoopLogger(),
    setLogForward: (forward) => {
      forwarding.push(forward !== null);
      onForwarding?.();
    },
    onDone: (reason) => done.push(reason),
  });
  await service.listen(socketPath);
  cleanups.push(() => {
    for (const id of host.sessionIds()) host.destroy(id);
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, socketPath, done, forwarding, forwardingChanged };
}

/** A raw protocol client: what it sent is framed by hand, and what it got is kept parsed. */
async function rawClient(socketPath: string) {
  const socket: Socket = createConnection(socketPath);
  const reader = new FrameReader();
  const received: { type: string }[] = [];
  const waiting: { type: string; resolve: (message: unknown) => void }[] = [];
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socket.on("data", (chunk: Buffer) => {
    for (const body of reader.push(chunk)) {
      if (body.kind !== "json") continue;
      const message = body.value as { type: string };
      received.push(message);
      for (const waiter of waiting.splice(0)) {
        if (waiter.type === message.type) waiter.resolve(message);
        else waiting.push(waiter);
      }
    }
  });
  socket.on("close", () => {
    closed = true;
    resolveClosed();
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => {
    socket.on("connect", () => resolve());
  });
  cleanups.push(() => socket.destroy());
  const send = (message: object) => socket.write(encodeJsonFrame(message));
  /** The first message of `type` received, waiting for it if need be. */
  const message = (type: string) => {
    const seen = received.find((m) => m.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise<unknown>((resolve) => {
      waiting.push({ type, resolve });
    });
  };
  return {
    received,
    send,
    message,
    closed: closedPromise,
    isClosed: () => closed,
    destroy: () => socket.destroy(),
    initialize: () => {
      send({ type: "initialize", protocol: "9.9.9", build: "test", capabilities: ["future"] });
      return message("initialize_result");
    },
  };
}

function spawnSleep(host: InProcessTerminalHost) {
  return host.spawn({
    id: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    argv: ["/bin/sh", "-c", "exec sleep 30"],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
    scrollbackLines: 100,
    meta: {},
  });
}

describe("TerminalHostService", () => {
  test("answers initialize from any protocol version, with its own", async () => {
    const { socketPath } = await startService();
    const client = await rawClient(socketPath);
    expect(await client.initialize()).toEqual({
      type: "initialize_result",
      protocol: TERMINAL_HOST_PROTOCOL,
      hostBuildId: "build-a",
      pid: process.pid,
      capabilities: [],
    });
  });

  test("closes a connection that speaks before initialize", async () => {
    const { socketPath, host } = await startService();
    await spawnSleep(host);
    const client = await rawClient(socketPath);
    client.send({ type: "list", requestId: 1 });
    await client.closed;
    expect(client.received).toEqual([]);
  });

  test("ends its sessions once a dropped server has not come back within the grace period", async () => {
    const { socketPath, host, done, forwardingChanged } = await startService();
    const client = await rawClient(socketPath);
    await client.initialize();
    await spawnSleep(host);

    jest.useFakeTimers();
    // The host has seen the server leave once it stops forwarding its log.
    const left = forwardingChanged();
    client.destroy();
    expect(await left).toBe(false);
    jest.advanceTimersByTime(TERMINAL_HOST_GRACE_MS - 1);
    expect(host.sessionIds()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(host.sessionIds()).toEqual([]);
    expect(done).toEqual(["grace period ended"]);
  });

  test("a server that comes back within the grace period keeps the sessions", async () => {
    const { socketPath, host, done, forwardingChanged } = await startService();
    const first = await rawClient(socketPath);
    await first.initialize();
    const { id } = await spawnSleep(host);

    jest.useFakeTimers();
    const left = forwardingChanged();
    first.destroy();
    await left;
    const second = await rawClient(socketPath);
    await second.initialize();
    jest.advanceTimersByTime(TERMINAL_HOST_GRACE_MS * 2);
    expect(host.sessionIds()).toEqual([id]);
    expect(done).toEqual([]);
  });

  test("disconnect with keep keeps the sessions with no deadline; end ends them", async () => {
    const { socketPath, host, done } = await startService();
    const keeper = await rawClient(socketPath);
    await keeper.initialize();
    await spawnSleep(host);

    jest.useFakeTimers();
    keeper.send({ type: "disconnect", sessions: "keep" });
    await keeper.closed;
    jest.advanceTimersByTime(TERMINAL_HOST_GRACE_MS * 10);
    expect(host.sessionIds()).toHaveLength(1);

    const ender = await rawClient(socketPath);
    await ender.initialize();
    ender.send({ type: "disconnect", sessions: "end" });
    await ender.closed;
    expect(host.sessionIds()).toEqual([]);
    expect(done).toEqual(["no sessions left"]);
  });

  test("terminate ends every session and the host", async () => {
    const { socketPath, host, done } = await startService();
    const client = await rawClient(socketPath);
    await client.initialize();
    await spawnSleep(host);
    client.send({ type: "terminate" });
    await client.closed;
    expect(host.sessionIds()).toEqual([]);
    expect(done).toEqual(["terminated"]);
  });

  test("a new server takes over: the old connection closes and its attaches are dropped", async () => {
    const { socketPath, host, forwarding } = await startService();
    const old = await rawClient(socketPath);
    await old.initialize();
    const { id } = await spawnSleep(host);
    old.send({ type: "attach", requestId: 1, request: { id, attachment: 1 } });
    await old.message("result");

    const next = await rawClient(socketPath);
    await next.initialize();
    await old.closed;
    // Nothing of the old attach reaches the new server, and the host still runs the session.
    expect(next.received.filter((m) => m.type === "state")).toEqual([]);
    expect(host.sessionIds()).toEqual([id]);
    expect(forwarding.at(-1)).toBe(true);
  });

  // Restart Loxel and an update overlap two servers: the old one disconnects with keep as it shuts
  // down, and the new one may initialize before or after that lands. Either way the shells run on.
  test("a restart keeps the sessions whether the old server's keep lands first or last", async () => {
    const { socketPath, host } = await startService();
    const old = await rawClient(socketPath);
    await old.initialize();
    const { id } = await spawnSleep(host);
    old.send({ type: "disconnect", sessions: "keep" });
    await old.closed;
    const next = await rawClient(socketPath);
    await next.initialize();
    expect(host.sessionIds()).toEqual([id]);

    // The next restart's new server initializes first; what the replaced one sends after that,
    // even an `end`, is ignored.
    const newest = await rawClient(socketPath);
    await newest.initialize();
    next.send({ type: "disconnect", sessions: "end" });
    await next.closed;
    newest.send({ type: "list", requestId: 1 });
    expect(await newest.message("result")).toMatchObject({ requestId: 1 });
    expect(host.sessionIds()).toEqual([id]);
  });

  test("a new host with no server waits the grace period for one, then exits", async () => {
    jest.useFakeTimers();
    const { done } = await startService();
    jest.advanceTimersByTime(TERMINAL_HOST_GRACE_MS);
    expect(done).toEqual(["grace period ended"]);
  });

  test("with no server connected, the last session's exit ends the host", async () => {
    const { socketPath, host, done } = await startService();
    const client = await rawClient(socketPath);
    await client.initialize();
    const { id } = await host.spawn({
      id: crypto.randomUUID(),
      epoch: crypto.randomUUID(),
      argv: ["/bin/sh", "-c", "read line"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
      cols: 80,
      rows: 24,
      scrollbackLines: 100,
      meta: {},
    });
    client.send({ type: "disconnect", sessions: "keep" });
    await client.closed;
    host.write(id, new TextEncoder().encode("\n"));
    await until(() => done.length > 0);
    expect(done).toEqual(["no sessions left"]);
  });
});
