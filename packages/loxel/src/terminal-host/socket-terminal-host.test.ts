import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { until } from "@/test/until";

import { openHostConnection } from "./host-connection";
import { TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import type { InitializeMessage } from "./protocol";
import { TERMINAL_HOST_PROTOCOL } from "./protocol";
import { HOST_LOST_EXIT_CODE, SocketTerminalHost } from "./socket-terminal-host";
import type { TerminalHostEvent, TerminalSpawnRequest } from "./terminal-host";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const INITIALIZE: InitializeMessage = {
  type: "initialize",
  protocol: TERMINAL_HOST_PROTOCOL,
  build: "test",
  capabilities: [],
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
  const service = new TerminalHostService({
    host,
    hostBuildId: "build-a",
    log: createNoopLogger(),
    setLogForward: () => {},
    onDone: (reason) => done.push(reason),
  });
  await service.listen(socketPath);
  cleanups.push(() => {
    for (const id of host.sessionIds()) host.destroy(id);
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, service, socketPath, done };
}

function connect(
  socketPath: string,
  overrides: { isProcessAlive?: (pid: number) => boolean } = {},
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

  test("reads a session's screen over the socket when the host has the screen capability", async () => {
    const { socketPath } = await startService();
    const { client } = connect(socketPath);

    const spawned = request("echo ready; exec sleep 30", { cols: 30, rows: 3 });
    await client.spawn(spawned);
    let lines: string[] = [];
    for (let attempt = 0; attempt < 500 && lines[0] !== "ready"; attempt++) {
      lines = (await client.screen(spawned.id))?.lines ?? [];
      if (lines[0] !== "ready") await Bun.sleep(10);
    }
    expect(lines).toEqual(["ready", "", ""]);
    expect(await client.screen(crypto.randomUUID())).toBeNull();
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

  test("reports every session ended with HOST_LOST_EXIT_CODE once the host is gone", async () => {
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

    expect(events.filter((event) => event.type === "exit")).toEqual([
      { type: "exit", id: spawned.id, epoch: spawned.epoch, exitCode: HOST_LOST_EXIT_CODE },
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
    expect(first.events.filter((event) => event.type === "exit")).toEqual([
      { type: "exit", id: spawned.id, epoch: spawned.epoch, exitCode: HOST_LOST_EXIT_CODE },
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
