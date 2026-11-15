import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ServerWebSocket } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

const stateDir = mkdtempSync(path.join(tmpdir(), "oxlint-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
// The worktree's Node as the test says: `env` is what the next resolution answers.
let nodeEnv: { nodePath: string; version?: string } | null = { nodePath: process.execPath };
void mock.module("./node-env", () => ({
  getNodeEnv: () => Promise.resolve({ env: nodeEnv }),
  subscribeNodeEnv: () => () => {},
}));

const { OxlintLspManager } = await import("./oxlint-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

// A stand-in for oxlint: reports each message as a string, which no URI translation touches.
const FAKE_OXLINT = `
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
      write({ id: msg.id, result: { capabilities: { args: process.argv.slice(2) } } });
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
let manager = new OxlintLspManager();

function write(rel: string, text = ""): string {
  const file = path.join(wt, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function install(dir = ".", version = "1.86.0", engines?: string): void {
  const packageDir = path.join(dir, "node_modules/oxlint");
  write(
    path.join(packageDir, "package.json"),
    JSON.stringify({ version, engines: engines ? { node: engines } : undefined }),
  );
  write(path.join(packageDir, "bin/oxlint"), FAKE_OXLINT);
}

function send(socket: FakeSocket, message: Record<string, unknown>): void {
  manager.handleMessage(socket.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
}

function open(socket: FakeSocket, file: string): string {
  const uri = `loxel://head${file}`;
  send(socket, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "javascript", version: 1, text: "var a;" } },
  });
  return uri;
}

const isInitializeResponse = (frame: Frame) => frame.id === 1;
const RUNNING = { capabilities: { args: ["--lsp"] } };
const NO_FEATURES = { capabilities: { textDocumentSync: { openClose: true, change: 0 } } };

async function start(): Promise<FakeSocket> {
  await manager.destroy();
  manager = new OxlintLspManager();
  const socket = fakeSocket();
  manager.createSession(socket.ws, wt);
  send(socket, { id: 1, method: "initialize", params: { capabilities: {} } });
  await socket.next(isInitializeResponse);
  return socket;
}

/** Everything the client sent reached the server or stopped: a later request's answer has come. */
async function settle(socket: FakeSocket): Promise<void> {
  send(socket, { id: "settle", method: "test/settle" });
  await socket.next((frame) => frame.id === "settle");
}

const received = (socket: FakeSocket) =>
  socket.frames
    .filter((frame) => frame.method === "test/received")
    .map((frame) => JSON.parse(String(frame.params?.json)) as Frame);

const warnings = (socket: FakeSocket) =>
  socket.frames
    .filter((frame) => frame.method === "window/showMessage")
    .map((frame) => String(frame.params?.message));

beforeEach(() => {
  wt = realpathSync(mkdtempSync(path.join(tmpdir(), "oxlint-lsp-wt-")));
  nodeEnv = { nodePath: process.execPath };
});

afterEach(async () => {
  await manager.destroy();
  setRepoTrusted(wt, false);
  rmSync(wt, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("in an untrusted repository", () => {
  test("nothing runs, even with oxlint installed", async () => {
    write(".oxlintrc.json");
    install();
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    expect(received(socket)).toEqual([]);
  });

  test("what is held back is reported only for a project using oxlint", async () => {
    const socket = await start();
    open(socket, write("a.js"));
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
    write(".oxlintrc.json");
    open(socket, write("b.js"));
    expect(getRepoTrustStatus(wt).restrictions[0]).toStartWith("oxlint doesn't run");
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

  test("the project's install runs with --lsp, nearest to the root first", async () => {
    write(".oxlintrc.json");
    install("packages/a");
    install();
    const socket = await start();
    const { result } = socket.frames.find(isInitializeResponse) as { result: object };
    expect(result).toEqual({ capabilities: { args: ["--lsp"] } });
  });

  test("with no sign of oxlint, an install alone starts nothing", async () => {
    install();
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
  });

  test("with no install, a project using oxlint is told what to run", async () => {
    write("package.json", JSON.stringify({ devDependencies: { oxlint: "1" } }));
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    open(socket, write("a.js"));
    expect(warnings(socket)[0]).toContain("Run `npm install`");
  });

  test("below the first version with a server, it says so and starts nothing", async () => {
    write(".oxlintrc.json");
    install(".", "1.28.0");
    const socket = await start();
    open(socket, write("a.js"));
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    expect(warnings(socket)[0]).toContain("Needs oxlint 1.29.0 or newer");
  });

  test("a Node outside the package's engines says so and starts nothing", async () => {
    write(".oxlintrc.json");
    install(".", "1.86.0", "^20.19.0 || >=22.12.0");
    nodeEnv = { nodePath: process.execPath, version: "18.20.0" };
    const socket = await start();
    open(socket, write("a.js"));
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    expect(warnings(socket)[0]).toContain("Needs Node ^20.19.0 || >=22.12.0");
  });

  test("a pre-release Node inside the package's engines runs", async () => {
    write(".oxlintrc.json");
    install(".", "1.86.0", ">=22.12.0");
    nodeEnv = { nodePath: process.execPath, version: "25.0.0-nightly20250101abc" };
    const socket = await start();
    expect(socket.frames.find(isInitializeResponse)?.result).toEqual(RUNNING);
  });

  test("a worktree with no sign of oxlint restarts only for what could change that", async () => {
    const socket = await start();
    manager.notifyWatchedFilesChanged(wt, [
      write("package.json", "{}"),
      path.join(wt, "node_modules/left-pad/package.json"),
    ]);
    send(socket, { id: 2, method: "shutdown" });
    await socket.next((frame) => frame.id === 2);
    write("package.json", JSON.stringify({ devDependencies: { oxlint: "1" } }));
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "package.json")]);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("files of no project using oxlint never reach it, and get a clean answer", async () => {
    write("packages/a/.oxlintrc.json");
    install();
    const socket = await start();
    const plain = open(socket, write("packages/b/z.js"));
    const linted = open(socket, write("packages/a/x.js"));
    send(socket, {
      id: 2,
      method: "textDocument/diagnostic",
      params: { textDocument: { uri: plain } },
    });
    send(socket, {
      id: 3,
      method: "textDocument/codeAction",
      params: { textDocument: { uri: plain } },
    });
    send(socket, {
      id: 4,
      method: "textDocument/diagnostic",
      params: { textDocument: { uri: linted } },
    });
    send(socket, { method: "textDocument/didChange", params: { textDocument: { uri: plain } } });
    send(socket, { method: "textDocument/didClose", params: { textDocument: { uri: plain } } });
    await settle(socket);
    expect(socket.frames.find((frame) => frame.id === 2)?.result).toEqual({
      kind: "full",
      items: [],
    });
    expect(socket.frames.find((frame) => frame.id === 3)?.result).toBeNull();
    expect(socket.frames.find((frame) => frame.id === 4)?.result).toEqual({ fromServer: true });
    const uris = received(socket).flatMap((frame) => {
      const textDocument = frame.params?.textDocument as { uri?: string } | undefined;
      return textDocument?.uri ? [textDocument.uri] : [];
    });
    expect(uris).toEqual([`file://${wt}/packages/a/x.js`, `file://${wt}/packages/a/x.js`]);
  });

  test("a source action is asked for the whole file, a quick fix for its range", async () => {
    write(".oxlintrc.json");
    install();
    const socket = await start();
    const uri = open(socket, write("a.js"));
    const range = { start: { line: 3, character: 1 }, end: { line: 3, character: 1 } };
    const request = (id: number, only?: string[]) =>
      send(socket, {
        id,
        method: "textDocument/codeAction",
        params: { textDocument: { uri }, range, context: { diagnostics: [], only } },
      });
    request(2, ["source.fixAll"]);
    request(3, ["quickfix"]);
    await settle(socket);
    const rangeOf = (id: number) =>
      received(socket).find((frame) => frame.id === id)?.params?.range;
    expect(rangeOf(2)).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 2_147_483_647, character: 0 },
    });
    expect(rangeOf(3)).toEqual(range);
  });

  test("a subproject with a config and no install it resolves is told what to run", async () => {
    write("packages/a/.oxlintrc.json");
    write("packages/b/.oxlintrc.json");
    install("packages/a");
    const socket = await start();
    open(socket, write("packages/b/z.js"));
    await settle(socket);
    expect(warnings(socket)).toEqual([
      "b uses oxlint, but oxlint isn't installed. Run `npm install --save-dev oxlint` in that folder.",
    ]);
  });

  test.each([
    ["a config", "packages/a/.oxlintrc.json"],
    ["a TypeScript config", "oxlint.config.ts"],
    ["a manifest", "package.json"],
    ["an ignore file", ".gitignore"],
    ["an install", "node_modules/oxlint/package.json"],
  ])("a change of %s restarts a running server", async (_what, rel) => {
    write(".oxlintrc.json");
    install();
    const socket = await start();
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "src/a.js")]);
    await settle(socket);
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, rel)]);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("an install appearing restarts a held connection", async () => {
    write(".oxlintrc.json");
    const socket = await start();
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "node_modules/oxlint/package.json")]);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("it is told of no watched file, and asks for no settings", async () => {
    write(".oxlintrc.json");
    install();
    const socket = await start();
    const [initialize] = received(socket);
    expect(initialize?.method).toBe("initialize");
    expect(initialize?.params?.capabilities).toEqual({});
  });

  test("revoking trust stops the server", async () => {
    write(".oxlintrc.json");
    install();
    const socket = await start();
    setRepoTrusted(wt, false);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("an untrusted repository above the worktree holding its type checker holds it back", async () => {
    const outer = realpathSync(mkdtempSync(path.join(tmpdir(), "oxlint-lsp-outer-")));
    const previous = wt;
    wt = path.join(outer, "wt");
    try {
      mkdirSync(path.join(outer, "node_modules/.bin"), { recursive: true });
      writeFileSync(path.join(outer, "node_modules/.bin/tsgolint"), "");
      write(".oxlintrc.json");
      install();
      setRepoTrusted(wt, true);
      const socket = await start();
      expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
      open(socket, write("a.js"));
      expect(warnings(socket)[0]).toContain(outer);
      setRepoTrusted(outer, true);
      expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
      const running = await start();
      expect(running.frames.find(isInitializeResponse)?.result).toEqual(RUNNING);
      setRepoTrusted(outer, false);
      expect(await running.closed).toBe(LSP_RESTART_CLOSE_CODE);
      await manager.destroy();
      setRepoTrusted(wt, false);
    } finally {
      wt = previous;
      rmSync(outer, { recursive: true, force: true });
    }
  });

  describe("with a nested repository holding an oxlint config", () => {
    beforeEach(() => {
      write(".oxlintrc.json");
      install();
      write("vendor/clone/.git/HEAD");
      write("vendor/clone/oxlint.config.ts");
    });

    test("nothing starts while it isn't trusted, and the user hears what to do", async () => {
      const socket = await start();
      expect(socket.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
      open(socket, write("a.js"));
      expect(warnings(socket)[0]).toContain("vendor/clone");
    });

    test("trusting it restarts, and then the server runs", async () => {
      const socket = await start();
      setRepoTrusted(path.join(wt, "vendor/clone"), true);
      expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
      const again = await start();
      expect(again.frames.find(isInitializeResponse)?.result).toEqual({
        capabilities: { args: ["--lsp"] },
      });
      setRepoTrusted(path.join(wt, "vendor/clone"), false);
      expect(await again.closed).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("one created while a server runs restarts it", async () => {
      rmSync(path.join(wt, "vendor"), { recursive: true });
      const socket = await start();
      expect(socket.frames.find(isInitializeResponse)?.result).toEqual({
        capabilities: { args: ["--lsp"] },
      });
      const config = write("late/clone/oxlint.config.ts");
      write("late/clone/.git/HEAD");
      manager.notifyWatchedFilesChanged(wt, [config]);
      expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
      const again = await start();
      expect(again.frames.find(isInitializeResponse)?.result).toEqual(NO_FEATURES);
    });
  });
});
