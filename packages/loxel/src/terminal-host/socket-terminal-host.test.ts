import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { TERMINAL_HOST_PROTOCOL } from "@/api/terminal-host-protocol-version";
import { until } from "@/test/until";

import { openHostConnection } from "./host-connection";
import { TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import type { InitializeMessage } from "./protocol";
import { TERMINAL_HOST_CAPABILITIES } from "./protocol";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";
import { SocketTerminalHost, type SocketTerminalHostOptions } from "./socket-terminal-host";
import type { TerminalHostEvent, TerminalSpawnRequest } from "./terminal-host";

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
  overrides: Pick<SocketTerminalHostOptions, "isProcessAlive" | "connect"> = {},
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
  received: { type: string; requestId?: number; sessions?: string }[];
}

/**
 * A host as a bare socket, for states the real service passes through too fast to act in: it
 * answers `initialize`, and `list` with no sessions unless told to hold it, and closes a
 * connection that sends `disconnect`. `onMessage` runs after each message is recorded.
 */
async function startScriptedHost() {
  const dir = mkdtempSync(join(tmpdir(), "ths-"));
  const socketPath = join(dir, "host.sock");
  const connections: ScriptedConnection[] = [];
  const script = { holdList: false, onMessage: () => {} };
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
        if (message.type === "list" && !script.holdList) {
          socket.write(
            encodeJsonFrame({ type: "result", requestId: message.requestId, value: [] }),
          );
        }
        if (message.type === "disconnect") socket.end();
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
