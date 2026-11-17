import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { leaveStaleSocket } from "@/test/stale-socket";

import { clearSocketPath, listenOnPrivateSocket } from "./cli-socket";

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

function serveText(text: string) {
  return (path: string) => {
    const server = Bun.serve({ unix: path, fetch: () => new Response(text) });
    servers.push(server);
    return server;
  };
}

/** What the server does at startup. */
async function listen(path: string, text: string) {
  return (await clearSocketPath(path)) ? listenOnPrivateSocket(path, serveText(text)) : null;
}

async function answer(path: string): Promise<string> {
  const response = await fetch("http://localhost/", { unix: path });
  return response.text();
}

describe("the CLI socket", () => {
  test("listens on a socket only this user can open, in a private directory", async () => {
    const path = socketPath();
    const server = await listen(path, "hello");

    expect(server).not.toBeNull();
    expect(lstatSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(await answer(path)).toBe("hello");
  });

  test("makes an existing directory private", async () => {
    const path = socketPath();
    mkdirSync(join(path, ".."), { recursive: true });
    chmodSync(join(path, ".."), 0o755);

    await listen(path, "hello");

    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  test("replaces a stale socket a dead server left", async () => {
    const path = socketPath();
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    await leaveStaleSocket(path);
    expect(lstatSync(path).isSocket()).toBe(true);

    const server = await listen(path, "new");

    expect(server).not.toBeNull();
    expect(await answer(path)).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("replaces a file that is not a socket", async () => {
    const path = socketPath();
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    await Bun.write(path, "not a socket");

    expect(await listen(path, "new")).not.toBeNull();
    expect(await answer(path)).toBe("new");
  });

  test("leaves a socket a live server answers on to that server", async () => {
    const path = socketPath();
    await listen(path, "draining");

    expect(await clearSocketPath(path)).toBe(false);

    expect(await answer(path)).toBe("draining");
  });

  test("stopping the server removes its socket", async () => {
    const path = socketPath();
    const server = await listen(path, "hello");

    server?.stop();

    expect(existsSync(path)).toBe(false);
  });
});
