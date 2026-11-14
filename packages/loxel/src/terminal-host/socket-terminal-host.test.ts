import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { TERMINAL_HOST_PROTOCOL } from "@/api/terminal-host-protocol-version";
import { until } from "@/test/until";

import { HostConnectError, LEAVE_TIMEOUT_MS, openHostConnection } from "./host-connection";
import { TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import type { InitializeMessage } from "./protocol";
import { TERMINAL_HOST_CAPABILITIES } from "./protocol";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";
import {
  RECONNECT_REPORT_INTERVAL_MS,
  REQUEST_TIMEOUTS_MS,
  STALLED_AFTER_MS,
  SocketTerminalHost,
  type SocketTerminalHostOptions,
} from "./socket-terminal-host";
import type { TerminalHostEvent, TerminalSpawnRequest } from "./terminal-host";
import { TerminalHostPool } from "./terminal-host-pool";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const INITIALIZE: InitializeMessage = {
  type: "initialize",
  protocol: TERMINAL_HOST_PROTOCOL,
  build: "test",
  capabilities: [...TERMINAL_HOST_CAPABILITIES],
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host service in this process on a temporary socket, as the host process runs one. */
async function startService() {
  const dir = mkdtempSync(join(tmpdir(), "th-"));
  const socketPath = join(dir, "host.sock");
  const host = new InProcessTerminalHost({ log: createNoopLogger() });
  const done: string[] = [];
  let hasServer = false;
  const service = new TerminalHostService({
    host,
    hostBuildId: "build-a",
    log: createNoopLogger(),
    // The host forwards its log to the server it has, and stops once that server is gone.
    setLogForward: (forward) => {
      hasServer = forward !== null;
    },
    onDone: (reason) => done.push(reason),
  });
  await service.listen(socketPath);
  cleanups.push(() => {
    host.destroyAll();
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, service, socketPath, done, dir, hasServer: () => hasServer };
}

/**
 * A socket in front of the host's: `cut()` closes every connection through it and holds the next
 * ones, as a connection blip whose reconnect is slow, until `release()` lets them through.
 */
async function startProxy(dir: string, target: string) {
  const socketPath = join(dir, "proxy.sock");
  const open = new Set<Socket>();
  let held: (() => void)[] | null = null;
  const server = createServer((client) => {
    const forward = () => {
      const upstream = createConnection(target);
      for (const socket of [client, upstream]) {
        open.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => {
          open.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
      // What the client sent while held, its initialize, was buffered until now.
      client.pipe(upstream);
      upstream.pipe(client);
    };
    if (held) held.push(forward);
    else forward();
  });
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  cleanups.push(() => {
    for (const socket of open) socket.destroy();
    server.close();
  });
  return {
    socketPath,
    cut: () => {
      held = [];
      for (const socket of open) socket.destroy();
    },
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const forward of waiting) forward();
    },
  };
}

function connect(
  socketPath: string,
  overrides: Partial<Pick<SocketTerminalHostOptions, "isProcessAlive" | "connect" | "log">> = {},
) {
  const client = new SocketTerminalHost(
    {
      hostId: "abcdef01",
      socketPath,
      initialize: INITIALIZE,
      log: createNoopLogger(),
      ...overrides,
    },
    openHostConnection(socketPath, INITIALIZE),
  );
  const events: TerminalHostEvent[] = [];
  client.onEvent((event) => events.push(event));
  cleanups.push(() => client.drop());
  const outputText = (id: string) =>
    events
      .map((event) => (event.type === "output" && event.id === id ? event.data : null))
      .filter((data) => data !== null)
      .map((data) => textDecoder.decode(data))
      .join("");
  return { client, events, outputText };
}

/** One connection to a {@link startScriptedHost}, and the messages the host got on it. */
interface ScriptedConnection {
  socket: Socket;
  received: {
    type: string;
    requestId?: number;
    sessions?: string;
    id?: string;
    request?: TerminalSpawnRequest;
  }[];
}

/**
 * A host as a bare socket, for states the real service passes through too fast to act in: it
 * answers `initialize`, `list` with no sessions unless told to hold it, and `spawn` with the
 * session it asks for, and closes a connection that sends `disconnect`; while `holdAll`, it
 * answers nothing but `initialize`, and closes nothing. `onMessage` runs after each message is recorded.
 */
async function startScriptedHost() {
  const dir = mkdtempSync(join(tmpdir(), "ths-"));
  const socketPath = join(dir, "host.sock");
  const connections: ScriptedConnection[] = [];
  const script = { holdList: false, holdAll: false, onMessage: () => {} };
  const server: Server = createServer((socket) => {
    const reader = new FrameReader();
    const connection: ScriptedConnection = { socket, received: [] };
    connections.push(connection);
    socket.on("data", (chunk: Buffer) => {
      for (const body of reader.push(chunk)) {
        if (body.kind !== "json") continue;
        const message = body.value as ScriptedConnection["received"][number];
        connection.received.push(message);
        if (message.type === "initialize") {
          socket.write(
            encodeJsonFrame({
              type: "initialize_result",
              protocol: TERMINAL_HOST_PROTOCOL,
              hostBuildId: "build-a",
              pid: process.pid,
              capabilities: [],
            }),
          );
        }
        if (message.type === "list" && !script.holdList && !script.holdAll) {
          socket.write(
            encodeJsonFrame({ type: "result", requestId: message.requestId, value: [] }),
          );
        }
        if (message.type === "spawn" && message.request && !script.holdAll) {
          const { id, epoch, cols, rows, meta } = message.request;
          const value = { id, epoch, offset: 0, pid: process.pid, cols, rows, meta };
          socket.write(encodeJsonFrame({ type: "result", requestId: message.requestId, value }));
        }
        if (message.type === "disconnect" && !script.holdAll) socket.end();
        script.onMessage();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  cleanups.push(() => {
    for (const { socket } of connections) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Resolves once `condition` holds, checked as each message arrives. */
  const whenReceived = (condition: () => boolean) =>
    new Promise<void>((resolve) => {
      if (condition()) resolve();
      script.onMessage = () => {
        if (condition()) resolve();
      };
    });
  return { socketPath, connections, script, whenReceived };
}

function request(
  script: string,
  overrides: Partial<TerminalSpawnRequest> = {},
): TerminalSpawnRequest {
  return {
    id: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    argv: ["/bin/sh", "-c", script],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    scrollbackLines: 1_000,
    meta: { worktreePath: "/wt/a" },
    ...overrides,
  };
}

describe("SocketTerminalHost against the host service", () => {
  test("carries spawn, typed-ahead input, attach, output and list over the socket", async () => {
    const { socketPath } = await startService();
    const { client, events, outputText } = connect(socketPath);

    const spawned = request("read line; echo got:$line; exec sleep 30", {
      input: textEncoder.encode("typed\n"),
    });
    const info = await client.spawn(spawned);
    expect(info).toMatchObject({ id: spawned.id, epoch: spawned.epoch, cols: 80, rows: 24 });
    await client.attach({ id: spawned.id, attachment: 7 });
    expect(events.find((event) => event.type === "state")).toMatchObject({
      attachment: 7,
      state: { id: spawned.id, epoch: spawned.epoch },
    });
    // Printed before the attach, it is in the snapshot; after, in the output.
    const screen = () => {
      const state = events.find((event) => event.type === "state");
      return (state?.type === "state" ? (state.state.snapshot ?? "") : "") + outputText(spawned.id);
    };
    await until(() => screen().includes("got:typed"));

    // Output from now on: the frame is passed on as it arrived, with the payload a view of it.
    client.write(spawned.id, textEncoder.encode("more\n"));
    await until(() => events.some((event) => event.type === "output"));
    const output = events.find((event) => event.type === "output");
    expect(output?.type === "output" && output.data.buffer === output.frame.buffer).toBe(true);

    client.setMeta(spawned.id, { worktreePath: "/wt/b" });
    const listed = await client.list();
    expect(listed).toEqual([
      expect.objectContaining({ id: spawned.id, meta: { worktreePath: "/wt/b" } }),
    ]);
  });

  test("reports an exit with the spawn's epoch, and a rejected spawn with its cause", async () => {
    const { socketPath } = await startService();
    const { client, events } = connect(socketPath);

    const spawned = request("exit 3");
    await client.spawn(spawned);
    await until(() => events.some((event) => event.type === "exit"));
    expect(events.find((event) => event.type === "exit")).toEqual({
      type: "exit",
      id: spawned.id,
      epoch: spawned.epoch,
      exitCode: 3,
    });

    const running = request("exec sleep 30");
    await client.spawn(running);
    await expect(client.spawn({ ...running, epoch: crypto.randomUUID() })).rejects.toThrow(
      "already running",
    );
  });

  test("restores a closed connection to a running host, resuming the attached client", async () => {
    const { socketPath, host } = await startService();
    const { client, events, outputText } = connect(socketPath);
    const spawned = request("read line; echo after:$line; exec sleep 30");
    await client.spawn(spawned);
    await client.attach({ id: spawned.id, attachment: 1 });

    // The host sees the server's connection close, as after a protocol error.
    const before = events.length;
    const reconnected = new Promise<void>((resolve) => {
      client.onEvent((event) => {
        if (event.type === "state" && event.state.mode === "resume") resolve();
      });
    });
    (client as unknown as { connection: { destroy(): void } }).connection.destroy();
    await reconnected;

    // Same attachment, resumed where the client was: no snapshot, nothing ended.
    const restored = events.slice(before);
    expect(restored.find((event) => event.type === "state")).toMatchObject({
      attachment: 1,
      state: { mode: "resume" },
    });
    expect(restored.some((event) => event.type === "exit")).toBe(false);
    client.write(spawned.id, textEncoder.encode("x\n"));
    await until(() => outputText(spawned.id).includes("after:x"));
    expect(host.sessionIds()).toEqual([spawned.id]);
  });

  test("a session that ended during a reconnect is reported with its real code after its missed output", async () => {
    const service = await startService();
    const proxy = await startProxy(service.dir, service.socketPath);
    const { client, events, outputText } = connect(proxy.socketPath);
    const spawned = request("read line; echo final words; exit 4");
    await client.spawn(spawned);
    await client.attach({ id: spawned.id, attachment: 1 });

    // The connection drops, and the program ends before the client is back.
    proxy.cut();
    await until(() => !service.hasServer());
    const before = events.length;
    service.host.write(spawned.id, textEncoder.encode("\n"));
    await until(() => service.host.endedSessionCount === 1);
    proxy.release();
    await until(() => events.some((event) => event.type === "exit"));

    const restored = events.slice(before);
    expect(restored.find((event) => event.type === "state")).toMatchObject({
      attachment: 1,
      state: { mode: "resume" },
    });
    expect(outputText(spawned.id)).toContain("final words");
    expect(restored.filter((event) => event.type === "exit" || event.type === "lost")).toEqual([
      { type: "exit", id: spawned.id, epoch: spawned.epoch, exitCode: 4 },
    ]);
    expect(restored.at(-1)?.type).toBe("exit");
  });

  test("a session that ended during a reconnect with no client is reported ended at once, and drained later", async () => {
    const service = await startService();
    const proxy = await startProxy(service.dir, service.socketPath);
    const { client, events, outputText } = connect(proxy.socketPath);
    const spawned = request("read line; echo final words; exit 4");
    await client.spawn(spawned);

    // Its panel is not mounted: no client is attached when the connection drops.
    proxy.cut();
    await until(() => !service.hasServer());
    service.host.write(spawned.id, textEncoder.encode("\n"));
    await until(() => service.host.endedSessionCount === 1);
    proxy.release();
    await until(() => events.some((event) => event.type === "ended"));
    expect(events.filter((event) => event.type !== "output")).toEqual([
      { type: "ended", id: spawned.id, epoch: spawned.epoch, exitCode: 4, outputKept: true },
    ]);
    expect(service.host.endedSessionCount).toBe(1);

    // The panel mounts later and gets what it missed, then the exit.
    await client.attach({ id: spawned.id, attachment: 1 });
    await until(() => events.some((event) => event.type === "exit"));
    const state = events.find((event) => event.type === "state");
    const screen =
      (state?.type === "state" ? (state.state.snapshot ?? "") : "") + outputText(spawned.id);
    expect(screen).toContain("final words");
    expect(events.at(-1)).toEqual({
      type: "exit",
      id: spawned.id,
      epoch: spawned.epoch,
      exitCode: 4,
    });
  });

  test("reports every session lost, with no exit code, once the host is gone", async () => {
    const { socketPath, service, host } = await startService();
    const { client, events } = connect(socketPath, { isProcessAlive: () => false });
    const spawned = request("exec sleep 30");
    await client.spawn(spawned);
    const gone = new Promise<void>((resolve) => {
      client.onGone(resolve);
    });

    // The host process dying: its sessions and its socket go with it.
    for (const id of host.sessionIds()) host.destroy(id);
    service.close();
    rmSync(socketPath, { force: true });
    await gone;

    expect(events.filter((event) => event.type === "exit" || event.type === "lost")).toEqual([
      { type: "lost", id: spawned.id, epoch: spawned.epoch, reason: "host_lost" },
    ]);
    await expect(client.list()).rejects.toThrow("not available");
  });

  test("disconnect with end ends the sessions and the host", async () => {
    const { socketPath, host, done } = await startService();
    const { client } = connect(socketPath);
    await client.spawn(request("exec sleep 30"));
    await client.disconnect("end");
    expect(host.sessionIds()).toEqual([]);
    expect(done).toEqual(["no sessions left"]);
  });

  test("a server another one took the host over from stops using it, and does not take it back", async () => {
    const { socketPath, host } = await startService();
    const first = connect(socketPath);
    const spawned = request("exec sleep 30");
    await first.client.spawn(spawned);
    const firstGone = new Promise<void>((resolve) => {
      first.client.onGone(resolve);
    });

    const second = connect(socketPath);
    expect(await second.client.list()).toEqual([expect.objectContaining({ id: spawned.id })]);
    await firstGone;

    // The first server sees its terminals end; the session runs on for the second.
    expect(first.events.filter((event) => event.type === "lost")).toEqual([
      { type: "lost", id: spawned.id, epoch: spawned.epoch, reason: "host_lost" },
    ]);
    first.client.destroy(spawned.id);
    expect(await second.client.list()).toHaveLength(1);
    expect(host.sessionIds()).toEqual([spawned.id]);
  });

  test("a restored connection ends a session the host runs that the client does not know", async () => {
    const { socketPath, host } = await startService();
    const { client } = connect(socketPath);
    const known = request("exec sleep 30");
    await client.spawn(known);
    // As if the client's destroy of it had been lost with the connection.
    const unknown = await host.spawn(request("exec sleep 30"));

    (client as unknown as { connection: { destroy(): void } }).connection.destroy();
    await until(() => !host.sessionIds().includes(unknown.id));
    expect(host.sessionIds()).toEqual([known.id]);
  });
});

describe("SocketTerminalHost leaving while it reconnects", () => {
  /** A connected client, and how to drop its connection from the host's side. */
  async function connectedClient(host: Awaited<ReturnType<typeof startScriptedHost>>) {
    const { client } = connect(host.socketPath);
    await client.list();
    return { client, dropConnection: () => host.connections[0]!.socket.destroy() };
  }

  test("keep reaches the host over the connection being restored", async () => {
    const host = await startScriptedHost();
    const { client, dropConnection } = await connectedClient(host);
    host.script.holdList = true;
    const restoring = host.whenReceived(
      () => host.connections[1]?.received.at(-1)?.type === "list",
    );
    dropConnection();
    await restoring;

    await client.disconnect("keep");
    expect(host.connections[1]!.received.at(-1)).toEqual({ type: "disconnect", sessions: "keep" });
  });

  test("keep waits for the reconnect under way, then reaches the host on its own connection", async () => {
    const host = await startScriptedHost();
    // The reconnect's connection settles only when the test lets it: until then
    // its `initialize` may still be on its way, and a keep sent before it would be superseded.
    const order: string[] = [];
    const reconnectSettles = Promise.withResolvers<void>();
    let opened = 0;
    const { client } = connect(host.socketPath, {
      connect: (socketPath, initialize) => {
        opened++;
        order.push(`connect ${opened}`);
        const connection = openHostConnection(socketPath, initialize);
        if (opened > 1) return connection;
        return connection.then(async (open) => {
          await reconnectSettles.promise;
          order.push("reconnect settled");
          return open;
        });
      },
    });
    await client.list();
    const reconnecting = host.whenReceived(() => host.connections.length === 2);
    host.connections[0]!.socket.destroy();
    await reconnecting;

    const left = client.disconnect("keep");
    reconnectSettles.resolve();
    await left;
    expect(order).toEqual(["connect 1", "reconnect settled", "connect 2"]);
    expect(host.connections[2]!.received).toEqual([
      expect.objectContaining({ type: "initialize" }),
      { type: "disconnect", sessions: "keep" },
    ]);
  });
});

/** A logger that keeps what it is given, by level. */
function recordingLog() {
  const lines: { level: string; msg: string }[] = [];
  const log = createNoopLogger();
  const record = (level: string) => (msg: string) => {
    lines.push({ level, msg });
  };
  const recorder = {
    ...log,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    with: () => recorder,
  };
  return { log: recorder, lines, at: (level: string) => lines.filter((l) => l.level === level) };
}

/** Let what the last event set off run up to its next timer. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("SocketTerminalHost and a host that stops answering", () => {
  test("a request the host does not answer fails after its timeout, and the next spawn starts another host", async () => {
    const stuck = await startScriptedHost();
    const answering = await startScriptedHost();
    const stateDir = mkdtempSync(join(tmpdir(), "thu-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const launched: string[] = [];
    const pool = new TerminalHostPool({
      stateDir,
      runDir: stateDir,
      socketDir: stateDir,
      serverBuild: "test",
      hostBuildId: "build-a",
      log: createNoopLogger(),
      perfLog: createNoopLogger(),
      launch: (launch) => {
        launched.push(launch.hostId);
        const host = launched.length === 1 ? stuck : answering;
        return Promise.resolve({ pid: process.pid, socketPath: host.socketPath });
      },
    });
    cleanups.push(() => pool.dropAll());
    await pool.start(() => {});
    const events: TerminalHostEvent[] = [];
    pool.onEvent((event) => events.push(event));
    const first = request("exec sleep 30");
    await pool.spawn(first);

    jest.useFakeTimers();
    stuck.script.holdAll = true;
    const stuckSpawn = request("exec sleep 30");
    const sent = stuck.whenReceived(() =>
      stuck.connections[0]!.received.some((message) => message.request?.id === stuckSpawn.id),
    );
    const failed = pool.spawn(stuckSpawn);
    await sent;
    jest.advanceTimersByTime(REQUEST_TIMEOUTS_MS.spawn);
    await expect(failed).rejects.toThrow("did not answer its spawn request within 10 s");
    // Its running session is told, and keeps running: nothing ended.
    expect(events).toEqual([{ type: "unresponsive", id: first.id, epoch: first.epoch }]);

    // Should the host get to the spawn after all, the destroy behind it ends it.
    const destroyed = stuck.whenReceived(() =>
      stuck.connections[0]!.received.some(
        (message) => message.type === "destroy" && message.id === stuckSpawn.id,
      ),
    );
    await destroyed;

    const next = request("exec sleep 30");
    await pool.spawn(next);
    expect(launched).toHaveLength(2);
    expect(answering.connections[0]!.received.some((m) => m.request?.id === next.id)).toBe(true);
  });

  test("answers again: takes new sessions again", async () => {
    const host = await startScriptedHost();
    const { client, events } = connect(host.socketPath);
    await client.list();
    const spawned = request("exec sleep 30");
    await client.spawn(spawned);

    jest.useFakeTimers();
    host.script.holdAll = true;
    const listed = host.whenReceived(() => host.connections[0]!.received.at(-1)?.type === "list");
    const unanswered = client.list();
    await listed;
    jest.advanceTimersByTime(REQUEST_TIMEOUTS_MS.list);
    await expect(unanswered).rejects.toThrow("did not answer its list request");
    expect(client.acceptsNewSessions).toBe(false);
    expect(events).toEqual([{ type: "unresponsive", id: spawned.id, epoch: spawned.epoch }]);

    host.script.holdAll = false;
    await client.list();
    expect(client.acceptsNewSessions).toBe(true);
  });

  test("an attach the host does not answer in time keeps waiting: its panel is told, and gets the session once the host answers", async () => {
    const host = await startScriptedHost();
    const { client, events } = connect(host.socketPath);
    await client.list();
    const spawned = request("exec sleep 30");
    await client.spawn(spawned);

    jest.useFakeTimers();
    let attached = false;
    const sent = host.whenReceived(() => host.connections[0]!.received.at(-1)?.type === "attach");
    const attaching = client.attach({ id: spawned.id, attachment: 1 }).then(() => {
      attached = true;
    });
    await sent;
    jest.advanceTimersByTime(REQUEST_TIMEOUTS_MS.attach);
    await settle();
    expect(attached).toBe(false);
    expect(client.acceptsNewSessions).toBe(false);
    const told: TerminalHostEvent = { type: "unresponsive", id: spawned.id, epoch: spawned.epoch };
    expect(events).toEqual([told]);
    // A panel that attaches meanwhile is told at once.
    void client.attach({ id: spawned.id, attachment: 2 }).catch(() => {});
    expect(events).toEqual([told, told]);

    const { requestId } = host.connections[0]!.received.find((m) => m.type === "attach")!;
    host.connections[0]!.socket.write(encodeJsonFrame({ type: "result", requestId, value: null }));
    await attaching;
    expect(client.acceptsNewSessions).toBe(true);
  });

  test("a host that answers the handshake but not the list is retried with the backoff, without flooding the log", async () => {
    const host = await startScriptedHost();
    const recorded = recordingLog();
    const { client } = connect(host.socketPath, { log: recorded.log, isProcessAlive: () => true });
    await client.list();
    host.script.holdList = true;

    jest.useFakeTimers();
    host.connections[0]!.socket.destroy();
    const started = Date.now();
    while (Date.now() - started < RECONNECT_REPORT_INTERVAL_MS + STALLED_AFTER_MS) {
      const count = host.connections.length;
      await host.whenReceived(() => host.connections[count]?.received.at(-1)?.type === "list");
      jest.advanceTimersByTime(REQUEST_TIMEOUTS_MS.list);
      await settle();
      jest.advanceTimersByTime(STALLED_AFTER_MS);
    }
    // One attempt per 40 s or so once unresponsive, rather than one every 10 s.
    expect(host.connections.length).toBeLessThan(13);
    expect(recorded.at("warn").map((line) => line.msg)).toEqual([
      "The connection to the terminal host closed, reconnecting",
      "Could not reconnect to the terminal host yet; retrying",
      expect.stringMatching(
        /^Still cannot reconnect to the terminal host: \d+ attempts in \d+ min$/,
      ),
    ]);
    expect(recorded.at("error")).toHaveLength(1);
    expect(client.acceptsNewSessions).toBe(false);
  });

  test("a host that cannot be reconnected to is reported unresponsive, retried without flooding the log, and resumed once it answers", async () => {
    const { socketPath, host } = await startService();
    const recorded = recordingLog();
    let blocked = false;
    let attempted = Promise.withResolvers<void>();
    const { client, events, outputText } = connect(socketPath, {
      log: recorded.log,
      isProcessAlive: () => true,
      // While blocked, every attempt fails as one to a host that does not answer.
      connect: (path, initialize) => {
        attempted.resolve();
        attempted = Promise.withResolvers<void>();
        if (!blocked) return openHostConnection(path, initialize);
        return Promise.reject(new HostConnectError("No answer", { refused: false }));
      },
    });
    const spawned = request("read line; echo after:$line; exec sleep 30");
    await client.spawn(spawned);
    await client.attach({ id: spawned.id, attachment: 1 });

    jest.useFakeTimers();
    blocked = true;
    const before = events.length;
    (client as unknown as { connection: { destroy(): void } }).connection.destroy();
    const started = Date.now();
    while (Date.now() - started < RECONNECT_REPORT_INTERVAL_MS + STALLED_AFTER_MS) {
      await attempted.promise;
      await settle();
      jest.advanceTimersByTime(STALLED_AFTER_MS);
    }
    expect(client.acceptsNewSessions).toBe(false);
    expect(events.slice(before)).toEqual([
      { type: "unresponsive", id: spawned.id, epoch: spawned.epoch },
    ]);
    // The first failure, one summary five minutes on, and one error: not one line per attempt.
    expect(recorded.at("warn").map((line) => line.msg)).toEqual([
      "The connection to the terminal host closed, reconnecting",
      "Could not reconnect to the terminal host yet; retrying",
      expect.stringMatching(/^Still cannot reconnect to the terminal host: \d+ attempts in 5 min$/),
    ]);
    expect(recorded.at("error").map((line) => line.msg)).toEqual([
      expect.stringContaining("The terminal host is not responding: no answer for 30 s"),
    ]);

    const resumed = new Promise<void>((resolve) => {
      client.onEvent((event) => {
        if (event.type === "state" && event.state.mode === "resume") resolve();
      });
    });
    // The attempt the last timer set off finds the host answering.
    blocked = false;
    await resumed;
    jest.useRealTimers();
    expect(client.acceptsNewSessions).toBe(true);
    expect(events.some((event) => event.type === "exit" || event.type === "lost")).toBe(false);
    client.write(spawned.id, textEncoder.encode("x\n"));
    await until(() => outputText(spawned.id).includes("after:x"));
    expect(host.sessionIds()).toEqual([spawned.id]);
  });

  test("leaving a connected host that does not close its connection resolves in time", async () => {
    const host = await startScriptedHost();
    const { client } = connect(host.socketPath);
    await client.list();
    host.script.holdAll = true;

    jest.useFakeTimers();
    let left = false;
    const leaving = client.disconnect("keep").then(() => {
      left = true;
    });
    await host.whenReceived(() => host.connections[0]!.received.at(-1)?.type === "disconnect");
    await settle();
    expect(left).toBe(false);
    jest.advanceTimersByTime(LEAVE_TIMEOUT_MS);
    await leaving;
    expect(host.connections[0]!.received.at(-1)).toEqual({ type: "disconnect", sessions: "keep" });
  });

  test("keep to a host that cannot be reached within the bound gives up in time", async () => {
    const host = await startScriptedHost();
    const attempted = Promise.withResolvers<void>();
    const { client } = connect(host.socketPath, {
      isProcessAlive: () => true,
      // Every reconnect hangs, as to a host that accepts connections but does not answer.
      connect: () => {
        attempted.resolve();
        return new Promise<never>(() => {});
      },
    });
    await client.list();
    jest.useFakeTimers();
    host.connections[0]!.socket.destroy();
    await attempted.promise;
    let left = false;
    const leaving = client.disconnect("keep").then(() => {
      left = true;
    });
    await settle();
    expect(left).toBe(false);
    jest.advanceTimersByTime(LEAVE_TIMEOUT_MS);
    await leaving;
    expect(left).toBe(true);
  });
});
