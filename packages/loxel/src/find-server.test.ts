import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { findServer, terminalSocket, waitForServer, wellKnownSockets } from "./find-server";
import { cliSocketPath } from "./socket-paths";
import { DEFAULT_STATE_DIR, STATE_BASE_DIR } from "./state-dir";

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

const versionFetch = (shuttingDown: boolean) => () => Response.json({ version: "1", shuttingDown });

function serveOnSocket(path: string, { shuttingDown = false } = {}): void {
  servers.push(Bun.serve({ unix: path, fetch: versionFetch(shuttingDown) }));
}

function serveOnPort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: versionFetch(false) });
  servers.push(server);
  return server.port!;
}

/** Never probe the ports of a Loxel running on this machine. */
const noLegacy = { legacyPorts: [] };

describe("findServer", () => {
  test("finds the server on its state directory's socket", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);

    expect(await findServer(env, noLegacy)).toEqual({
      address: { url: "http://localhost", unix: socket },
      given: false,
    });
  });

  test("does not count a server that is shutting down, or a socket nothing answers on", async () => {
    const { env, socket } = stateDir();
    expect(await findServer(env, noLegacy)).toBeNull();

    serveOnSocket(socket, { shuttingDown: true });
    expect(await findServer(env, noLegacy)).toBeNull();
  });

  test("says when the socket belongs to another user", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);
    // What connecting to another user's socket gets: no permission on it.
    chmodSync(socket, 0o000);

    await expect(findServer(env, noLegacy)).rejects.toThrow(
      `the Loxel server at ${socket} runs as another user`,
    );
  });

  test("takes LOXEL_SOCKET as given, answering or not", async () => {
    const { socket } = stateDir();
    const env = { LOXEL_SOCKET: socket };

    expect(await findServer(env, noLegacy)).toEqual({
      address: { url: "http://localhost", unix: socket },
      given: true,
    });
    serveOnSocket(socket);
    expect((await findServer(env, noLegacy))?.given).toBe(true);
  });

  test("says when LOXEL_SOCKET's directory cannot be found from here", async () => {
    const { socket } = stateDir();
    const hidden = join(dirname(socket), "not-here", "cli.sock");

    await expect(findServer({ LOXEL_SOCKET: hidden }, noLegacy)).rejects.toThrow(
      `cannot find Loxel's socket ${hidden}: if this runs in a sandbox, allow the path in its settings`,
    );
  });

  test("falls back to the port of a server from before the socket", async () => {
    const { env } = stateDir();
    const port = serveOnPort();

    expect(await findServer(env, { legacyPorts: [port] })).toEqual({
      address: { url: `http://127.0.0.1:${port}` },
      given: false,
    });
    // In a terminal of such a server, its port is taken as given.
    expect(await findServer({ ...env, LOXEL: "1", LOXEL_PORT: "7499" }, noLegacy)).toEqual({
      address: { url: "http://127.0.0.1:7499" },
      given: true,
    });
  });

  test("in a terminal from before the socket, takes its server's socket after an update", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);
    const port = serveOnPort();

    const found = await findServer(
      { ...env, LOXEL: "1", LOXEL_PORT: String(port) },
      { legacyPorts: [port] },
    );

    expect(found).toEqual({ address: { url: "http://localhost", unix: socket }, given: true });
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

describe("terminalSocket", () => {
  test("is the socket of the mode a terminal's LOXEL_PORT is the port of", () => {
    expect(terminalSocket({}, 7433)).toBe(cliSocketPath(DEFAULT_STATE_DIR.production));
    expect(terminalSocket({}, 7434)).toBe(cliSocketPath(DEFAULT_STATE_DIR.dev));
    expect(terminalSocket({}, 7435)).toBe(cliSocketPath(`${STATE_BASE_DIR}/loxel-demo`));
    expect(terminalSocket({}, 7437)).toBe(cliSocketPath(`${STATE_BASE_DIR}/loxel-demo-2`));
    expect(terminalSocket({}, 3000)).toBeNull();
    expect(terminalSocket({ LOXEL_STATE_DIR: "/state" }, 7434)).toBe("/state/run/cli.sock");
  });
});

describe("waitForServer", () => {
  test("returns the server once it answers", async () => {
    const { env, socket } = stateDir();
    serveOnSocket(socket);

    expect(await waitForServer(env, noLegacy)).toEqual({ url: "http://localhost", unix: socket });
  });

  test("gives up when none answers in time", async () => {
    const { env } = stateDir();

    await expect(waitForServer(env, { ...noLegacy, timeoutMs: 0 })).rejects.toThrow(
      "Loxel server did not start within 0s",
    );
  });
});
