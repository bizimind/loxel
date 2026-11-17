import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { leaveStaleSocket } from "@/test/stale-socket";

import { findServer, givenServerGone, waitForServer, wellKnownSockets } from "./find-server";
import { cliSocketPath } from "./socket-paths";
import { DEFAULT_STATE_DIR } from "./state-dir";

// The package's test preload replaces `fetch` with a browser one, which has no `unix` option.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

const dirs: string[] = [];
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A state directory of its own, as `LOXEL_STATE_DIR` names it, and its server's socket. */
function stateDir(): { env: { LOXEL_STATE_DIR: string }; socket: string } {
  const dir = mkdtempSync(join(tmpdir(), "lfs-"));
  dirs.push(dir);
  const socket = cliSocketPath(dir);
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  return { env: { LOXEL_STATE_DIR: dir }, socket };
}

function serveOnSocket(path: string, { shuttingDown = false } = {}): void {
  servers.push(
    Bun.serve({ unix: path, fetch: () => Response.json({ version: "1", shuttingDown }) }),
  );
}

describe("findServer", () => {
  test("finds the server on its state directory's socket", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);

    expect(await findServer(env)).toEqual({ socket, given: false });
  });

  test("does not count a server that is shutting down, or a socket nothing answers on", async () => {
    const { env, socket } = stateDir();
    expect(await findServer(env)).toBeNull();

    serveOnSocket(socket, { shuttingDown: true });
    expect(await findServer(env)).toBeNull();
  });

  test("says when the socket belongs to another user", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);
    // What connecting to another user's socket gets: no permission on it.
    chmodSync(socket, 0o000);

    await expect(findServer(env)).rejects.toThrow(
      `the Loxel server at ${socket} runs as another user`,
    );
  });

  test("does not use a socket in a directory others can enter", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);
    chmodSync(dirname(socket), 0o755);
    const reason = `${dirname(socket)} is not a private directory of this user's`;

    await expect(findServer(env)).rejects.toThrow(reason);
    await expect(findServer({ LOXEL_SOCKET: socket })).rejects.toThrow(reason);
  });

  test("takes LOXEL_SOCKET as given, answering or not", async () => {
    const { socket } = stateDir();
    const env = { LOXEL_SOCKET: socket };

    expect(await findServer(env)).toEqual({ socket, given: true });
    serveOnSocket(socket);
    expect((await findServer(env))?.given).toBe(true);
  });

  test("says when LOXEL_SOCKET's directory cannot be found from here", async () => {
    const { socket } = stateDir();
    const hidden = join(dirname(socket), "not-here", "cli.sock");

    await expect(findServer({ LOXEL_SOCKET: hidden })).rejects.toThrow(
      `cannot find Loxel's socket ${hidden}: if this runs in a sandbox, allow the path in its settings`,
    );
  });

  test("treats a stale socket file as no server", async () => {
    const { env, socket } = stateDir();
    await leaveStaleSocket(socket);

    expect(await findServer(env)).toBeNull();
  });
});

describe("wellKnownSockets", () => {
  test("is LOXEL_STATE_DIR's socket, else production's then dev's", () => {
    expect(wellKnownSockets({ LOXEL_STATE_DIR: "/state" })).toEqual(["/state/run/cli.sock"]);
    expect(wellKnownSockets({})).toEqual([
      cliSocketPath(DEFAULT_STATE_DIR.production),
      cliSocketPath(DEFAULT_STATE_DIR.dev),
    ]);
  });
});

describe("givenServerGone", () => {
  test("is false at once for a production socket a server answers on", async () => {
    const { socket } = stateDir();
    serveOnSocket(socket);
    let waited = false;

    const gone = await givenServerGone(socket, {
      productionSocket: socket,
      onWaiting: () => (waited = true),
    });

    expect(gone).toBe(false);
    expect(waited).toBe(false);
  });

  test("is false for a server that comes back within the grace period", async () => {
    const { socket } = stateDir();
    const gone = givenServerGone(socket, {
      productionSocket: socket,
      graceMs: 60_000,
      // The server comes back once the CLI is waiting for it.
      onWaiting: () => serveOnSocket(socket),
    });

    expect(await gone).toBe(false);
  });

  test("is true when no server answers on the production socket in time", async () => {
    const { socket } = stateDir();
    await leaveStaleSocket(socket);

    expect(await givenServerGone(socket, { productionSocket: socket, graceMs: 0 })).toBe(true);
  });

  test("starts the grace period only once a draining server is gone", async () => {
    const { socket } = stateDir();
    serveOnSocket(socket, { shuttingDown: true });

    const gone = await givenServerGone(socket, {
      productionSocket: socket,
      graceMs: 0,
      maxWaitMs: 60_000,
      // The draining server exits once the CLI is waiting for it, leaving no server.
      onWaiting: () => servers.pop()?.stop(true),
    });

    expect(gone).toBe(true);
  });

  test("is false for a server that stays draining, which launching Loxel would not help", async () => {
    const { socket } = stateDir();
    serveOnSocket(socket, { shuttingDown: true });

    const gone = await givenServerGone(socket, {
      productionSocket: socket,
      graceMs: 0,
      maxWaitMs: 0,
    });

    expect(gone).toBe(false);
  });

  test("is false for any other socket, which launching Loxel would not bring back", async () => {
    const { socket } = stateDir();

    expect(await givenServerGone(socket, { graceMs: 0 })).toBe(false);
  });
});

describe("waitForServer", () => {
  test("returns the server once it answers", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);

    expect(await waitForServer(env)).toBe(socket);
  });

  test("gives up when none answers in time", async () => {
    const { env } = stateDir();

    await expect(waitForServer(env, { timeoutMs: 0 })).rejects.toThrow(
      "Loxel server did not start within 0s",
    );
  });
});
