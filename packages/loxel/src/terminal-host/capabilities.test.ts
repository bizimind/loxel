/**
 * The capability path, with `foregroundProcess` as its first capability: a server uses a
 * capability's messages only with a host that advertises it too, in both directions of a version
 * skew, and the host implements what it advertises.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { TERMINAL_HOST_PROTOCOL } from "@/api/terminal-host-protocol-version";

import { openHostConnection } from "./host-connection";
import { TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import type { InitializeMessage, InitializeResult } from "./protocol";
import { TERMINAL_HOST_CAPABILITIES, compatibility, sharedCapabilities } from "./protocol";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";
import { SocketTerminalHost } from "./socket-terminal-host";
import type { ForegroundProcesses, TerminalSpawnRequest } from "./terminal-host";

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

function socketPathInTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "host.sock");
}

/**
 * A host of another version, as a bare socket: it answers `initialize` with `hello`, answers a
 * `foreground_processes` request with `foreground`, and records every message it gets.
 */
async function startFakeHost(
  hello: Omit<InitializeResult, "type">,
  foreground: ForegroundProcesses = {},
) {
  const socketPath = socketPathInTempDir();
  const received: { type: string }[] = [];
  const server: Server = createServer((socket) => {
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => {
      for (const body of reader.push(chunk)) {
        if (body.kind !== "json") continue;
        const message = body.value as { type: string; requestId?: number };
        received.push(message);
        if (message.type === "initialize") {
          socket.write(encodeJsonFrame({ type: "initialize_result", ...hello }));
        } else if (message.type === "foreground_processes") {
          socket.write(
            encodeJsonFrame({ type: "result", requestId: message.requestId, value: foreground }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  cleanups.push(() => {
    server.close();
  });
  return { socketPath, received };
}

async function connect(socketPath: string): Promise<SocketTerminalHost> {
  const connection = openHostConnection(socketPath, INITIALIZE);
  const client = new SocketTerminalHost(
    { hostId: "abcdef01", socketPath, initialize: INITIALIZE, log: createNoopLogger() },
    connection,
  );
  cleanups.push(() => client.drop());
  // The client took the connection in its own callback on it, registered first, so it ran first.
  await connection;
  return client;
}

describe("capabilities", () => {
  test("an older host without the capability is never sent its messages", async () => {
    const older = await startFakeHost({
      protocol: "1.0.0",
      hostBuildId: "older",
      pid: process.pid,
      capabilities: [],
    });
    const client = await connect(older.socketPath);

    expect(client.supports("foregroundProcess")).toBe(false);
    // The caller falls back: nothing is known about the host's sessions.
    expect(await client.foregroundProcesses()).toEqual({});
    expect(older.received.map((message) => message.type)).toEqual(["initialize"]);
  });

  test("a newer host's capabilities this server does not know go unused", async () => {
    const id = crypto.randomUUID();
    const hello = {
      protocol: "1.7.0",
      hostBuildId: "newer",
      pid: process.pid,
      capabilities: ["foregroundProcess", "teleport"],
    };
    expect(compatibility(hello, INITIALIZE)).toMatchObject({
      status: "degraded",
      unshared: ["teleport"],
    });
    expect([...sharedCapabilities(hello, INITIALIZE)]).toEqual(["foregroundProcess"]);

    const newer = await startFakeHost(hello, { [id]: "vim" });
    const client = await connect(newer.socketPath);
    expect(client.supports("foregroundProcess")).toBe(true);
    expect(await client.foregroundProcesses()).toEqual({ [id]: "vim" });
  });

  test("a server without the capability does not use it with a host that has it", () => {
    const host = {
      protocol: TERMINAL_HOST_PROTOCOL,
      capabilities: [...TERMINAL_HOST_CAPABILITIES],
    };
    expect(sharedCapabilities(host, { protocol: "1.0.0", capabilities: [] }).size).toBe(0);
    expect(
      sharedCapabilities({ protocol: "2.0.0", capabilities: ["foregroundProcess"] }, host).size,
    ).toBe(0);
  });
});

describe("foregroundProcess", () => {
  function shell(): TerminalSpawnRequest {
    return {
      id: crypto.randomUUID(),
      epoch: crypto.randomUUID(),
      // Interactive, so the shell runs each command as a job in its own foreground group.
      argv: ["/bin/sh", "-i"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", PS1: "$ " },
      cols: 80,
      rows: 24,
      scrollbackLines: 100,
      meta: {},
    };
  }

  /** Ask until `done` holds: the shell starts the program on its own time. */
  async function foregroundUntil(
    read: () => Promise<ForegroundProcesses>,
    done: (programs: ForegroundProcesses) => boolean,
  ): Promise<ForegroundProcesses> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const programs = await read();
      if (done(programs)) return programs;
      if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(programs)}`);
      await Bun.sleep(20);
    }
  }

  test("the host names a session's foreground program, and null at the shell's prompt", async () => {
    const socketPath = socketPathInTempDir();
    const host = new InProcessTerminalHost({ log: createNoopLogger() });
    const service = new TerminalHostService({
      host,
      hostBuildId: "current",
      log: createNoopLogger(),
      setLogForward: () => {},
      onDone: () => {},
    });
    await service.listen(socketPath);
    cleanups.push(() => {
      for (const id of host.sessionIds()) host.destroy(id);
      service.close();
    });
    const client = await connect(socketPath);
    expect(client.supports("foregroundProcess")).toBe(true);

    const atPrompt = shell();
    const busy = shell();
    // The shell replaced by the program: the session's own process, but no longer the shell.
    const execed = shell();
    for (const request of [atPrompt, busy, execed]) await client.spawn(request);
    client.write(busy.id, new TextEncoder().encode("sleep 30\n"));
    client.write(execed.id, new TextEncoder().encode("exec sleep 30\n"));

    const programs = await foregroundUntil(
      () => client.foregroundProcesses(),
      (found) => found[busy.id] === "sleep" && found[execed.id] === "sleep",
    );
    expect(programs[atPrompt.id]).toBeNull();
  });

  test("a host's handshake says how many sessions it runs", async () => {
    const socketPath = socketPathInTempDir();
    const host = new InProcessTerminalHost({ log: createNoopLogger() });
    const service = new TerminalHostService({
      host,
      hostBuildId: "current",
      log: createNoopLogger(),
      setLogForward: () => {},
      onDone: () => {},
    });
    await service.listen(socketPath);
    cleanups.push(() => {
      for (const id of host.sessionIds()) host.destroy(id);
      service.close();
    });
    await host.spawn(shell());
    const connection = await openHostConnection(socketPath, INITIALIZE);
    cleanups.push(() => connection.destroy());
    expect(connection.result.sessions).toBe(1);
  });

  test("a 1.0.0 host's handshake, without a session count, still parses", async () => {
    const older = await startFakeHost({
      protocol: "1.0.0",
      hostBuildId: "older",
      pid: process.pid,
      capabilities: [],
    });
    const client = await connect(older.socketPath);
    expect(client.initializeResult).toMatchObject({ protocol: "1.0.0" });
    expect(client.initializeResult?.sessions).toBeUndefined();
  });
});
