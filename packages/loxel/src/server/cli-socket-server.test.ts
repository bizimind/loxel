/**
 * The CLI socket of a real server process: what `server.ts` wires up around cli-socket.ts and the
 * admission rules in request-origin.ts. `LOXEL_DEV=1` keeps the server off the keychain, and a
 * temporary state directory off the user's projects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ServerNotification } from "@/api/notification-model";
import { cliSocketPath } from "@/socket-paths";
import { leaveStaleSocket } from "@/test/stale-socket";

// The package's test preload replaces `fetch` with a browser one, which has no `unix` option.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

const LOXEL_ROOT = path.resolve(import.meta.dir, "../..");
const STARTUP_TIMEOUT_MS = 60_000;
/** A shutdown drains API requests and waits for language servers and terminal hosts. */
const SHUTDOWN_TIMEOUT_MS = 20_000;

/** A port free right now: the server takes its port from the environment. */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/** A server process for `stateDir`, once it answers on its loopback port. */
async function startServer(stateDir: string) {
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: LOXEL_ROOT,
    env: {
      ...process.env,
      LOXEL_DEV: "1",
      LOXEL_STATE_DIR: stateDir,
      LOXEL_SERVE_PORT: String(port),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  // Polled: the server signals nothing else when it starts listening. It listens on its CLI socket
  // in the same step.
  while (!(await fetch(`${baseUrl}/api/version`).catch(() => null))?.ok) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${server.exitCode}`);
    await Bun.sleep(50);
  }
  return { server, port, baseUrl };
}

const tempStateDir = () => realpathSync(mkdtempSync(path.join(tmpdir(), "loxel-cli-socket-")));

// The tests share one server and run in order: the last one shuts it down.
describe("a server's CLI socket", () => {
  let stateDir: string;
  let socket: string;
  let baseUrl: string;
  let server: ReturnType<typeof Bun.spawn>;

  const overSocket = (pathname: string, init: RequestInit = {}) =>
    fetch(`http://localhost${pathname}`, { ...init, unix: socket });

  beforeAll(async () => {
    stateDir = tempStateDir();
    socket = cliSocketPath(stateDir);
    // What a server killed with SIGKILL leaves behind.
    mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    await leaveStaleSocket(socket);
    ({ server, baseUrl } = await startServer(stateDir));
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => {
    server.kill("SIGKILL");
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("takes the stale socket's name over with one only this user can open", () => {
    expect(lstatSync(socket).isSocket()).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
  });

  test("serves the CLI's routes", async () => {
    const version = await overSocket("/api/version");
    expect(version.status).toBe(200);
    expect(await version.json()).toMatchObject({ shuttingDown: false });

    // Routed to the open handler, which has no window to send the file to.
    const open = await overSocket("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: stateDir }),
    });
    expect(open.status).toBe(503);
  });

  test("keeps the JSON rule for mutations", async () => {
    const open = await overSocket("/api/open", { method: "POST", body: "{}" });
    expect(open.status).toBe(415);
  });

  test("refuses every other route, the WebSocket and static files", async () => {
    for (const pathname of ["/api/projects", "/api/terminals", "/ws", "/"]) {
      const response = await overSocket(pathname);
      expect(response.status).toBe(403);
    }
  });

  test("leaves the loopback port as it was", async () => {
    expect((await fetch(`${baseUrl}/api/projects`)).status).toBe(200);
  });

  test(
    "leaves the socket's name for the next server when it shuts down",
    async () => {
      server.kill("SIGTERM");
      await server.exited;
      // Nothing listens there any more: the CLI's connection is refused, which is no server.
      expect(existsSync(socket)).toBe(true);
    },
    SHUTDOWN_TIMEOUT_MS,
  );
});

describe("a server that cannot listen on its CLI socket", () => {
  let stateDir: string;
  let started: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    stateDir = tempStateDir();
    // A file where the socket's directory goes.
    writeFileSync(path.dirname(cliSocketPath(stateDir)), "");
    started = await startServer(stateDir);
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => {
    started.server.kill("SIGKILL");
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("still serves the app on its loopback port", async () => {
    expect((await fetch(`${started.baseUrl}/api/projects`)).status).toBe(200);
  });

  test("tells the app's windows the loxel command cannot reach it, and why", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws`);
    const synced = new Promise<ServerNotification[]>((resolve, reject) => {
      ws.addEventListener("error", () => reject(new Error("WebSocket error")));
      ws.addEventListener("message", (event) => {
        const message: unknown = JSON.parse(String(event.data));
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "notifications_sync" &&
          "data" in message
        ) {
          resolve(message.data as ServerNotification[]);
        }
      });
    });
    const notifications = await synced;
    ws.close();

    expect(notifications).toContainEqual(
      expect.objectContaining({
        source: { kind: "server" },
        title: "The loxel command cannot reach Loxel",
        body: expect.stringContaining(cliSocketPath(stateDir)),
      }),
    );
  });
});
