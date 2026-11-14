import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import type { ChildLogger } from "@/api/log-entry-model";
import { TERMINAL_HOST_PROTOCOL } from "@/api/terminal-host-protocol-version";
import { until } from "@/test/until";

import { NotificationQueue, TERMINAL_HOST_GRACE_MS, TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import { TERMINAL_HOST_CAPABILITIES } from "./protocol";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startService({ log = createNoopLogger() }: { log?: ChildLogger } = {}) {
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
    log,
    setLogForward: (forward) => {
      forwarding.push(forward !== null);
      onForwarding?.();
    },
    onDone: (reason) => done.push(reason),
  });
  await service.listen(socketPath);
  cleanups.push(() => {
    host.destroyAll();
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, socketPath, done, forwarding, forwardingChanged };
}

/** A logger that resolves `logged(text)` once a line containing `text` was logged. */
function waitableLog() {
  const lines: string[] = [];
  const waiting: { text: string; resolve: () => void }[] = [];
  const record = (msg: string) => {
    lines.push(msg);
    for (const waiter of waiting.splice(0)) {
      if (msg.includes(waiter.text)) waiter.resolve();
      else waiting.push(waiter);
    }
  };
  const log: ChildLogger = { ...createNoopLogger(), info: record, warn: record };
  const logged = (text: string) =>
    lines.some((line) => line.includes(text))
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiting.push({ text, resolve });
        });
  return { log, logged };
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
    /** Initialize as a server of this build, with `capabilities` (all of this build's). */
    initializeAsCurrent: (capabilities: readonly string[] = TERMINAL_HOST_CAPABILITIES) => {
      send({
        type: "initialize",
        protocol: TERMINAL_HOST_PROTOCOL,
        build: "test",
        capabilities: [...capabilities],
      });
      return message("initialize_result");
    },
  };
}

/** A session that waits for a line, then raises a notification, prints and exits with 4. */
function spawnFinishing(host: InProcessTerminalHost) {
  return host.spawn({
    id: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    argv: ["/bin/sh", "-c", "read line; printf '\\033]9;done\\007'; echo final words; exit 4"],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
    scrollbackLines: 100,
    meta: {},
  });
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
      capabilities: [...TERMINAL_HOST_CAPABILITIES],
      sessions: 0,
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

  test("an exit and a notification while no server is connected reach the next server", async () => {
    const { socketPath, host, done } = await startService();
    const first = await rawClient(socketPath);
    await first.initializeAsCurrent();
    const { id, epoch } = await spawnFinishing(host);
    first.send({ type: "disconnect", sessions: "keep" });
    await first.closed;
    const raised: string[] = [];
    host.onEvent((event) => raised.push(event.type));
    host.write(id, new TextEncoder().encode("\n"));
    await until(() => raised.includes("osc") && host.endedSessionCount === 1);
    expect(done).toEqual([]);

    const next = await rawClient(socketPath);
    await next.initializeAsCurrent();
    expect(await next.message("osc")).toEqual({ type: "osc", id, epoch, code: 9, data: "done" });
    expect(next.received.map((message) => message.type)).toEqual(["initialize_result", "osc"]);
    next.send({ type: "list", requestId: 1 });
    expect(await next.message("result")).toMatchObject({
      requestId: 1,
      value: [expect.objectContaining({ id, epoch, ended: { exitCode: 4, outputKept: true } })],
    });

    // The attach gets the screen as the program left it, then the real exit.
    next.send({ type: "attach", requestId: 2, request: { id, attachment: 1 } });
    expect(await next.message("exit")).toEqual({ type: "exit", id, epoch, exitCode: 4 });
    const state = next.received.find((message) => message.type === "state") as
      | { state: { snapshot?: string } }
      | undefined;
    expect(state?.state.snapshot).toContain("final words");
    expect(host.endedSessionCount).toBe(0);
  });

  test("with only ended sessions left and no server, the host waits the grace period, then exits", async () => {
    const { log, logged } = waitableLog();
    const { socketPath, host, done } = await startService({ log });
    const client = await rawClient(socketPath);
    await client.initializeAsCurrent();
    const { id } = await spawnFinishing(host);
    client.send({ type: "disconnect", sessions: "keep" });
    await client.closed;

    jest.useFakeTimers();
    host.write(id, new TextEncoder().encode("\n"));
    await logged("1 ended session(s) waiting for a server");
    jest.advanceTimersByTime(TERMINAL_HOST_GRACE_MS - 1);
    expect(host.endedSessionCount).toBe(1);
    expect(done).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(host.endedSessionCount).toBe(0);
    expect(done).toEqual(["grace period ended"]);
  });
});

describe("NotificationQueue", () => {
  const osc = (data: string) =>
    ({ type: "osc", id: "x".repeat(36), epoch: "e", code: 9, data }) as const;

  test("keeps the newest within its limits, counting the ones it dropped", () => {
    const byCount = new NotificationQueue({ events: 2, chars: 100 });
    for (const data of ["a", "b", "c"]) byCount.push(osc(data));
    expect(byCount.take()).toEqual({ events: [osc("b"), osc("c")], dropped: 1 });
    expect(byCount.take()).toEqual({ events: [], dropped: 0 });

    const byChars = new NotificationQueue({ events: 10, chars: 5 });
    for (const data of ["aaa", "bbb", "c"]) byChars.push(osc(data));
    expect(byChars.take()).toEqual({ events: [osc("bbb"), osc("c")], dropped: 1 });
  });
});
