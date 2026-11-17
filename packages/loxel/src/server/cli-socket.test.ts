import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { leaveStaleSocket } from "@/test/stale-socket";

import { takeOverSocket } from "./cli-socket";

// The package's test preload replaces `fetch` with a browser one, which has no `unix` option.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

const dirs: string[] = [];
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const base = mkdtempSync(join(tmpdir(), "lcs-"));
  dirs.push(base);
  return join(base, "run", "cli.sock");
}

/** Take the socket at `path` over with a server that answers `text`. */
function takeOver(path: string, text: string) {
  return takeOverSocket(path, (unix) => {
    const server = Bun.serve({ unix, fetch: () => new Response(text) });
    servers.push(server);
    return server;
  });
}

/** What a new connection to `path` gets: not a pooled one, which would reach an older server. */
async function answer(path: string): Promise<string> {
  try {
    const response = await fetch("http://localhost/", { unix: path, keepalive: false });
    return await response.text();
  } catch (err) {
    return err instanceof Error && "code" in err ? String(err.code) : String(err);
  }
}

describe("the CLI socket", () => {
  test("listens on a socket only this user can open, in a private directory", async () => {
    const path = socketPath();
    takeOver(path, "hello");

    expect(lstatSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(await answer(path)).toBe("hello");
    // The temporary name it listened on is gone.
    expect(readdirSync(dirname(path))).toEqual(["cli.sock"]);
  });

  test("makes an existing directory private", () => {
    const path = socketPath();
    mkdirSync(dirname(path), { recursive: true });
    chmodSync(dirname(path), 0o755);

    takeOver(path, "hello");

    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  test("takes over a stale socket a killed server left", async () => {
    const path = socketPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await leaveStaleSocket(path);
    expect(await answer(path)).toBe("ECONNREFUSED");

    takeOver(path, "new");

    expect(await answer(path)).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("takes over a file that is not a socket", async () => {
    const path = socketPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await Bun.write(path, "not a socket");

    takeOver(path, "new");

    expect(await answer(path)).toBe("new");
  });

  test("takes over a live server's socket, and stopping the older server leaves the new one", async () => {
    const path = socketPath();
    const older = takeOver(path, "older");

    takeOver(path, "newer");
    expect(await answer(path)).toBe("newer");

    older.stop();
    expect(await answer(path)).toBe("newer");
  });

  test("stopping the server leaves its socket's name, which then refuses connections", async () => {
    const path = socketPath();
    const socket = takeOver(path, "hello");

    await socket.stop();

    expect(readdirSync(dirname(path))).toEqual(["cli.sock"]);
    expect(await answer(path)).toBe("ECONNREFUSED");
  });

  test("leaves the path as it was when the socket cannot take its name", () => {
    const path = socketPath();
    // A directory with something in it cannot be renamed over.
    mkdirSync(join(path, "inside"), { recursive: true });

    expect(() => takeOver(path, "new")).toThrow();

    expect(readdirSync(dirname(path))).toEqual(["cli.sock"]);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });
});
