import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { until } from "@/test/until";

import { hostBinDir, hostEntryPath, hostLogPath, hostSocketPath } from "./host-files";
import type { HostLaunch } from "./host-launcher";
import { TerminalHostService } from "./host-service";
import { InProcessTerminalHost } from "./in-process-terminal-host";
import { FrameReader, encodeJsonFrame } from "./protocol-framing";
import type { TerminalHostEvent, TerminalSessionInfo, TerminalSpawnRequest } from "./terminal-host";
import { TerminalHostPool } from "./terminal-host-pool";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), "thp-"));
  const runDir = join(stateDir, "run");
  mkdirSync(runDir, { mode: 0o700 });
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, runDir };
}

/** A host of `build` serving in this process at `<runDir>/<hostId>.sock`, as its process would. */
async function startHost(runDir: string, hostId: string, build: string) {
  const host = new InProcessTerminalHost({ log: createNoopLogger() });
  const done: string[] = [];
  const service = new TerminalHostService({
    host,
    hostBuildId: build,
    log: createNoopLogger(),
    setLogForward: () => {},
    onDone: (reason) => done.push(reason),
  });
  const socketPath = hostSocketPath(runDir, hostId);
  await service.listen(socketPath);
  writeFileSync(
    hostEntryPath(runDir, hostId),
    JSON.stringify({ pid: process.pid, build, protocol: "1.0.0", socket: socketPath }),
  );
  /** As the process exiting would: the sessions, socket and entry go. */
  const stop = () => {
    for (const id of host.sessionIds()) host.destroy(id);
    service.close();
    rmSync(socketPath, { force: true });
    rmSync(hostEntryPath(runDir, hostId), { force: true });
  };
  cleanups.push(stop);
  return { host, done, socketPath, stop };
}

function spawnRequest(script: string): TerminalSpawnRequest {
  return {
    id: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    argv: ["/bin/sh", "-c", script],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
    scrollbackLines: 100,
    meta: { worktreePath: "/wt" },
  };
}

function createPool(
  stateDir: string,
  runDir: string,
  launch: (launch: HostLaunch) => Promise<{ pid: number; socketPath: string }> = () =>
    Promise.reject(new Error("no launch expected")),
) {
  const pool = new TerminalHostPool({
    stateDir,
    runDir,
    socketDir: runDir,
    serverBuild: "test",
    hostBuildId: "current",
    log: createNoopLogger(),
    launch,
  });
  const events: TerminalHostEvent[] = [];
  pool.onEvent((event) => events.push(event));
  cleanups.push(() => pool.dropAll());
  return { pool, events };
}

async function startPool(pool: TerminalHostPool): Promise<TerminalSessionInfo[]> {
  let adopted: TerminalSessionInfo[] = [];
  await pool.start((sessions) => {
    adopted = sessions;
  });
  return adopted;
}

describe("TerminalHostPool", () => {
  test("adopts a running host of this build and spawns new sessions in it", async () => {
    const { stateDir, runDir } = tempStateDir();
    const running = await startHost(runDir, "aaaaaaaa", "current");
    const survivor = await running.host.spawn(spawnRequest("exec sleep 30"));
    const { pool } = createPool(stateDir, runDir);

    const adopted = await startPool(pool);
    expect(adopted.map((info) => info.id)).toEqual([survivor.id]);

    const spawned = spawnRequest("exec sleep 30");
    await pool.spawn(spawned);
    expect(running.host.sessionIds().sort()).toEqual([survivor.id, spawned.id].sort());
  });

  test("starts a host for this build, and lets an earlier one go once its sessions end", async () => {
    const { stateDir, runDir } = tempStateDir();
    const old = await startHost(runDir, "bbbbbbbb", "older");
    const oldSession = await old.host.spawn(spawnRequest("read line"));
    const launches: HostLaunch[] = [];
    const { pool, events } = createPool(stateDir, runDir, async (launch) => {
      launches.push(launch);
      const started = await startHost(launch.runDir, launch.hostId, launch.hostBuildId);
      return { pid: process.pid, socketPath: started.socketPath };
    });
    await startPool(pool);

    const spawned = spawnRequest("exec sleep 30");
    await pool.spawn(spawned);
    expect(launches.map((launch) => launch.hostBuildId)).toEqual(["current"]);
    expect(old.host.sessionIds()).toEqual([oldSession.id]);

    // The earlier generation's last session ends: the pool reports it and lets that host go.
    pool.write(oldSession.id, new TextEncoder().encode("\n"));
    await until(() => old.done.length > 0);
    expect(events).toContainEqual(expect.objectContaining({ type: "exit", id: oldSession.id }));
    expect(old.done).toEqual(["no sessions left"]);
    expect(await pool.list()).toEqual([expect.objectContaining({ id: spawned.id })]);
  });

  test("lets an earlier generation's host with no sessions go at once", async () => {
    const { stateDir, runDir } = tempStateDir();
    const old = await startHost(runDir, "cccccccc", "older");
    const { pool } = createPool(stateDir, runDir);
    await startPool(pool);
    await until(() => old.done.length > 0);
    expect(old.done).toEqual(["no sessions left"]);
  });

  test("removes the entries of hosts that are gone, and ends hosts of another major", async () => {
    const { stateDir, runDir } = tempStateDir();
    // Gone: its process is not running and its socket is gone.
    writeFileSync(
      hostEntryPath(runDir, "dddddddd"),
      JSON.stringify({
        pid: 999_999,
        build: "x",
        protocol: "1.0.0",
        socket: hostSocketPath(runDir, "dddddddd"),
      }),
    );
    const received: unknown[] = [];
    const incompatible: Server = createServer((socket) => {
      const reader = new FrameReader();
      socket.on("data", (chunk: Buffer) => {
        for (const body of reader.push(chunk)) {
          if (body.kind !== "json") continue;
          received.push(body.value);
          if ((body.value as { type: string }).type === "initialize") {
            socket.write(
              encodeJsonFrame({
                type: "initialize_result",
                protocol: "2.0.0",
                hostBuildId: "future",
                pid: process.pid,
                capabilities: [],
              }),
            );
          } else {
            socket.end();
          }
        }
      });
    });
    await new Promise<void>((resolve) => {
      incompatible.listen(hostSocketPath(runDir, "eeeeeeee"), resolve);
    });
    cleanups.push(() => {
      incompatible.close();
    });
    const { pool } = createPool(stateDir, runDir);

    expect(await startPool(pool)).toEqual([]);
    expect(existsSync(hostEntryPath(runDir, "dddddddd"))).toBe(false);
    expect(received.map((message) => (message as { type: string }).type)).toEqual([
      "initialize",
      "terminate",
    ]);
  });

  test("removes binaries no live host runs, and day-old logs of hosts that are gone", async () => {
    const { stateDir, runDir } = tempStateDir();
    await startHost(runDir, "ffffffff", "older-live");
    const old = Date.now() / 1000 - 2 * 24 * 60 * 60;
    for (const build of ["current", "older-live", "unused"]) {
      mkdirSync(join(hostBinDir(stateDir), build), { recursive: true });
    }
    mkdirSync(join(stateDir, "logs"));
    const goneLog = hostLogPath(stateDir, "11111111");
    const liveLog = hostLogPath(stateDir, "ffffffff");
    const recentLog = hostLogPath(stateDir, "22222222");
    for (const log of [goneLog, `${goneLog}.stderr`, liveLog, recentLog]) writeFileSync(log, "");
    for (const log of [goneLog, `${goneLog}.stderr`, liveLog]) utimesSync(log, old, old);
    const { pool } = createPool(stateDir, runDir);

    await startPool(pool);
    expect(existsSync(join(hostBinDir(stateDir), "current"))).toBe(true);
    expect(existsSync(join(hostBinDir(stateDir), "older-live"))).toBe(true);
    expect(existsSync(join(hostBinDir(stateDir), "unused"))).toBe(false);
    expect(
      [goneLog, `${goneLog}.stderr`, liveLog, recentLog].map((log) => existsSync(log)),
    ).toEqual([false, false, true, true]);
  });

  test("a host that is gone reports its sessions ended, and the next spawn starts a new one", async () => {
    const { stateDir, runDir } = tempStateDir();
    const running = await startHost(runDir, "abababab", "current");
    const survivor = await running.host.spawn(spawnRequest("exec sleep 30"));
    const launches: string[] = [];
    const { pool, events } = createPool(stateDir, runDir, async (launch) => {
      launches.push(launch.hostId);
      const started = await startHost(launch.runDir, launch.hostId, launch.hostBuildId);
      return { pid: process.pid, socketPath: started.socketPath };
    });
    await startPool(pool);

    running.stop();
    await until(() => events.some((event) => event.type === "exit"));
    expect(events).toContainEqual({
      type: "exit",
      id: survivor.id,
      epoch: survivor.epoch,
      exitCode: 129,
    });

    await pool.spawn(spawnRequest("exec sleep 30"));
    expect(launches).toHaveLength(1);
  });

  test("a running host whose socket is gone is reported unreachable, not forgotten", async () => {
    const { stateDir, runDir } = tempStateDir();
    const entry = {
      pid: process.pid,
      build: "purged",
      protocol: "1.0.0",
      socket: hostSocketPath(runDir, "12121212"),
    };
    writeFileSync(hostEntryPath(runDir, "12121212"), JSON.stringify(entry));
    mkdirSync(join(hostBinDir(stateDir), "purged"), { recursive: true });
    const errors: string[] = [];
    const pool = new TerminalHostPool({
      stateDir,
      runDir,
      socketDir: runDir,
      serverBuild: "test",
      hostBuildId: "current",
      log: { ...createNoopLogger(), error: (msg: string) => errors.push(msg) },
    });
    cleanups.push(() => pool.dropAll());

    expect(await startPool(pool)).toEqual([]);
    expect(errors).toEqual(["Terminal host 12121212 is unreachable: its socket is gone"]);
    // Its entry and binary stay, for the process that still runs from it.
    expect(existsSync(hostEntryPath(runDir, "12121212"))).toBe(true);
    expect(existsSync(join(hostBinDir(stateDir), "purged"))).toBe(true);
  });
});
