import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ServerWebSocket } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

const stateDir = mkdtempSync(path.join(tmpdir(), "biome-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;

const { BiomeLspManager } = await import("./biome-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

// A stand-in for Biome: reports its arguments, home and each message, with a daemon as its child.
const FAKE_BIOME = `#!${process.execPath}
const daemon = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", "__run_server"], { stdio: ["ignore", "ignore", "ignore"] });
let buf = Buffer.alloc(0);
const write = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  process.stdout.write("Content-Length: " + body.byteLength + "\\r\\n\\r\\n");
  process.stdout.write(body);
};
for await (const chunk of process.stdin) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end < 0) break;
    const length = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.byteLength < end + 4 + length) break;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + length).toString());
    buf = buf.subarray(end + 4 + length);
    write({ method: "test/received", params: { json: JSON.stringify(msg) } });
    if (msg.method === "initialize") {
      const capabilities = { args: process.argv.slice(2), home: process.env.HOME, daemon: daemon.pid };
      write({ id: msg.id, result: { capabilities } });
    } else if (msg.id !== undefined) {
      write({ id: msg.id, result: { fromServer: true } });
    }
  }
}
`;

interface Frame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

function fakeSocket() {
  const frames: Frame[] = [];
  const waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  let close: (code: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    close = resolve;
  });
  const ws = {
    send(data: string) {
      const frame = JSON.parse(data) as Frame;
      frames.push(frame);
      for (const waiter of waiters) if (waiter.predicate(frame)) waiter.resolve(frame);
    },
    close(code: number) {
      close(code);
    },
  } as unknown as ServerWebSocket<unknown>;
  const next = (predicate: (frame: Frame) => boolean) => {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<Frame>((resolve) => {
      waiters.push({ predicate, resolve });
    });
  };
  return { ws, frames, closed, next };
}
type FakeSocket = ReturnType<typeof fakeSocket>;

let wt: string;
let scratch: string;
let manager = new BiomeLspManager();

function write(rel: string, text = "{}", root = wt): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function install(dir = "."): void {
  write(path.join(dir, "node_modules/@biomejs/biome/package.json"), '{"version":"2.6.4"}');
  const native = path.join(
    dir,
    `node_modules/@biomejs/cli-${process.platform}-${process.arch}/biome`,
  );
  chmodSync(write(native, FAKE_BIOME), 0o755);
}

function send(socket: FakeSocket, message: Record<string, unknown>): void {
  manager.handleMessage(socket.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
}

function open(socket: FakeSocket, file: string): void {
  send(socket, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: `loxel://head${file}`, languageId: "javascript", version: 1, text: "" },
    },
  });
}

const isInitializeResponse = (frame: Frame) => frame.id === 1;
const NO_FEATURES = { capabilities: { textDocumentSync: { openClose: true, change: 0 } } };

async function start(): Promise<FakeSocket> {
  await manager.destroy();
  manager = new BiomeLspManager();
  const socket = fakeSocket();
  manager.createSession(socket.ws, wt);
  send(socket, { id: 1, method: "initialize", params: { capabilities: {} } });
  await socket.next(isInitializeResponse);
  return socket;
}

interface Running {
  capabilities: { args: string[]; home: string; daemon: number };
}

const running = (socket: FakeSocket) => socket.frames.find(isInitializeResponse)?.result as Running;

const warnings = (socket: FakeSocket) =>
  socket.frames
    .filter((frame) => frame.method === "window/showMessage")
    .map((frame) => String(frame.params?.message));

/** Everything the client sent reached the server or stopped: a later request's answer has come. */
async function settle(socket: FakeSocket): Promise<void> {
  send(socket, { id: "settle", method: "test/settle" });
  await socket.next((frame) => frame.id === "settle");
}

const received = (socket: FakeSocket) =>
  socket.frames
    .filter((frame) => frame.method === "test/received")
    .map((frame) => JSON.parse(String(frame.params?.json)) as Frame);

function isAlive(pid: number): boolean {
  const { stdout } = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const state = stdout.toString().trim();
  return state !== "" && !state.startsWith("Z");
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "biome-lsp-wt-")));
  wt = path.join(scratch, "parent", "project");
  mkdirSync(wt, { recursive: true });
});

afterEach(async () => {
  await manager.destroy();
  setRepoTrusted(wt, false);
  rmSync(scratch, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("in an untrusted repository", () => {
  test("nothing runs, even with Biome installed", async () => {
    write("biome.json");
    install();
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
  });

  test("what is held back is reported only for a project using Biome", async () => {
    const socket = await start();
    open(socket, write("a.js"));
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
    write("biome.json");
    open(socket, write("b.js"));
    expect(getRepoTrustStatus(wt).restrictions[0]).toStartWith("Biome's linter doesn't run");
  });

  test("trusting it restarts the connection", async () => {
    const socket = await start();
    setRepoTrusted(wt, true);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });
});

describe("in a trusted repository", () => {
  beforeEach(() => {
    setRepoTrusted(wt, true);
  });

  for (const name of ["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"]) {
    test(`a root ${name} starts the platform binary`, async () => {
      write(name);
      install();
      const socket = await start();
      expect(running(socket).capabilities.args).toEqual(["lsp-proxy"]);
    });
  }

  test("an install in a package serves a root config", async () => {
    write("biome.json");
    install("packages/a");
    const socket = await start();
    expect(running(socket).capabilities.args).toEqual(["lsp-proxy"]);
  });

  test("a config only in a package starts nothing, as Biome would lint nothing", async () => {
    write("packages/a/biome.json");
    install();
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
  });

  test("with no install, a project with a config is told what to run", async () => {
    write("biome.json");
    write("pnpm-lock.yaml", "");
    const socket = await start();
    open(socket, write("a.js"));
    expect(warnings(socket)[0]).toContain("Run `pnpm add -D @biomejs/biome`");
  });

  test("an install without the platform binary says so", async () => {
    write("biome.json");
    write("node_modules/@biomejs/biome/package.json");
    const socket = await start();
    open(socket, write("a.js"));
    expect(warnings(socket)[0]).toContain("without its binary");
  });

  test("the daemon gets a short private home per worktree", async () => {
    write("biome.json");
    install();
    const socket = await start();
    const { home } = running(socket).capabilities;
    expect(home).toMatch(/^\/tmp\/lxb-\d+-[a-z0-9]+$/);
    expect(home.length).toBeLessThan(30);
  });

  test("the daemon stops with the session", async () => {
    write("biome.json");
    install();
    const socket = await start();
    const { daemon } = running(socket).capabilities;
    expect(isAlive(daemon)).toBe(true);
    await manager.destroy();
    expect(isAlive(daemon)).toBe(false);
  });

  test("a nested repository with a config holds it until that repository is trusted", async () => {
    write("biome.json");
    install();
    write("vendor/lib/.git/config", "");
    write("vendor/lib/biome.json");
    const socket = await start();
    open(socket, write("a.js"));
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    expect(warnings(socket)[0]).toContain(path.join("vendor", "lib"));
    setRepoTrusted(path.join(wt, "vendor/lib"), true);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
    setRepoTrusted(path.join(wt, "vendor/lib"), false);
  });

  test("a nested repository git ignores counts, as Biome walks it", async () => {
    write("biome.json");
    write(".gitignore", "vendor/\n");
    write(".git/config", "");
    install();
    write("vendor/lib/.git/config", "");
    write("vendor/lib/biome.json");
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
  });

  test("a config in node_modules or behind a link does not count", async () => {
    write("biome.json");
    install();
    write("node_modules/dep/.git/config", "");
    write("node_modules/dep/biome.json");
    const socket = await start();
    expect(running(socket).capabilities.args).toEqual(["lsp-proxy"]);
  });

  test("root: false holds it until the repository of the config above is trusted", async () => {
    write("biome.json", '{ "root": false }');
    install();
    write("biome.json", "{}", path.dirname(wt));
    const socket = await start();
    open(socket, write("a.js"));
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    expect(warnings(socket)[0]).toContain("above this worktree");
  });

  test("a root config ignores what lies above the worktree", async () => {
    write("biome.json");
    install();
    write("biome.json", "{}", path.dirname(wt));
    const socket = await start();
    expect(running(socket).capabilities.args).toEqual(["lsp-proxy"]);
  });

  test("a config that doesn't parse counts as looking above", async () => {
    write("biome.json", "{ not json");
    install();
    write("biome.json", "{}", path.dirname(wt));
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
  });

  test("a walk over the limit holds it", async () => {
    write("biome.json");
    install();
    const { scanBiomeWorktree } = await import("./biome-project");
    write("a/b.js");
    const scan = await scanBiomeWorktree(wt, { maxDirs: 1 });
    expect(scan.incomplete).toBe(true);
  });

  test("formatting never reaches the client", async () => {
    write("biome.json");
    install();
    const socket = await start();
    await settle(socket);
    const hook = (manager as unknown as { suppressedFeatures: readonly string[] })
      .suppressedFeatures;
    expect(hook).toEqual(["textDocument/formatting", "textDocument/rangeFormatting"]);
  });

  test("Organize Imports stays with the TypeScript server, other source actions reach Biome", async () => {
    write("biome.json");
    install();
    const socket = await start();
    const params = (only: string[]) => ({
      textDocument: { uri: `loxel://head${path.join(wt, "a.js")}` },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only },
    });
    send(socket, {
      id: 2,
      method: "textDocument/codeAction",
      params: params(["source.organizeImports"]),
    });
    send(socket, { id: 3, method: "textDocument/codeAction", params: params(["source.fixAll"]) });
    expect((await socket.next((frame) => frame.id === 2)).result).toEqual([]);
    expect((await socket.next((frame) => frame.id === 3)).result).toEqual({ fromServer: true });
    const asked = received(socket).filter((frame) => frame.method === "textDocument/codeAction");
    expect(asked.map((frame) => frame.id)).toEqual([3]);
  });

  test("a config change restarts it and is not forwarded", async () => {
    write("biome.json");
    install();
    const socket = await start();
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "biome.json")]);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
    expect(received(socket).some((frame) => frame.method?.includes("didChangeWatched"))).toBe(
      false,
    );
  });

  test("a change to an ordinary file changes nothing", async () => {
    write("biome.json");
    install();
    const socket = await start();
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "src/a.js")]);
    await settle(socket);
    expect(running(socket).capabilities.args).toEqual(["lsp-proxy"]);
  });

  test("a held connection restarts when a config appears", async () => {
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    manager.notifyWatchedFilesChanged(wt, [write("biome.json")]);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });
});
