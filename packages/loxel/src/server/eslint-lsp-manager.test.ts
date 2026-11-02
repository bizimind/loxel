import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

import type { EslintLaunch, EslintNoLaunch } from "./eslint-lsp-manager";

const stateDir = mkdtempSync(path.join(tmpdir(), "eslint-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
// The worktree's Node as the test says, not as this machine resolves it: a running server restarts
// when the two differ.
const nodeListeners = new Set<(update: { env: { nodePath: string } | null }) => void>();
void mock.module("./node-env", () => ({
  getNodeEnv: () => Promise.resolve({ env: { nodePath: process.execPath } }),
  subscribeNodeEnv: (
    _wtPath: string,
    listener: (update: { env: { nodePath: string } | null }) => void,
  ) => {
    nodeListeners.add(listener);
    return () => nodeListeners.delete(listener);
  },
}));

const { EslintLspManager } = await import("./eslint-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");
type Context = import("./stdio-lsp-manager").WtLspContext;

// A stand-in for the server: reports each message as a string, which no URI translation touches,
// and sends on whatever `test/send` carries.
const FAKE_SERVER = `
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
    if (msg.method === "test/send") write(msg.params);
    else write({ method: "test/received", params: { json: JSON.stringify(msg) } });
    if (msg.method === "initialize") {
      write({ id: msg.id, result: { capabilities: { documentFormattingProvider: true, hoverProvider: true } } });
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

interface FakeSocket {
  ws: ServerWebSocket<unknown>;
  closed: Promise<number>;
  next(predicate: (frame: Frame) => boolean): Promise<Frame>;
  frames: Frame[];
  /** The first message of `method` the server received. */
  received(method: string): Promise<Frame>;
}

function fakeSocket(): FakeSocket {
  const frames: Frame[] = [];
  const waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  let close: (code: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    close = resolve;
  });
  const next = (predicate: (frame: Frame) => boolean) => {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<Frame>((resolve) => {
      waiters.push({ predicate, resolve });
    });
  };
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
  const parseReceived = (frame: Frame) => JSON.parse(String(frame.params?.json)) as Frame;
  return {
    ws,
    closed,
    next,
    frames,
    async received(method) {
      const frame = await next(
        (f) => f.method === "test/received" && parseReceived(f).method === method,
      );
      return parseReceived(frame);
    },
  };
}

class TestManager extends EslintLspManager {
  lookups = 0;

  constructor(private readonly launch: EslintLaunch | EslintNoLaunch | Promise<EslintLaunch>) {
    super();
  }

  protected override findLaunch(_context: Context): Promise<EslintLaunch | EslintNoLaunch> {
    this.lookups++;
    return Promise.resolve(this.launch);
  }
}

const scriptDir = mkdtempSync(path.join(tmpdir(), "eslint-lsp-script-"));
const script = path.join(scriptDir, "server.mjs");
writeFileSync(script, FAKE_SERVER);
const LAUNCH: EslintLaunch = { node: process.execPath, server: script };
const RESTRICTION = "ESLint doesn't run";

let wt: string;
let manager: TestManager;

function write(rel: string, text = ""): string {
  const file = path.join(wt, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function send(socket: FakeSocket, message: Record<string, unknown>): void {
  manager.handleMessage(socket.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
}

function open(socket: FakeSocket, file: string, languageId = "javascript"): string {
  const uri = `loxel://head${file}`;
  send(socket, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId, version: 1, text: "var a;" } },
  });
  return uri;
}

const initializeRequest = { id: 1, method: "initialize", params: { capabilities: {} } };
const isInitializeResponse = (frame: Frame) => frame.id === 1;

function start(launch: EslintLaunch | EslintNoLaunch | Promise<EslintLaunch>): FakeSocket {
  manager = new TestManager(launch);
  const socket = fakeSocket();
  manager.createSession(socket.ws, wt);
  send(socket, initializeRequest);
  return socket;
}

beforeEach(() => {
  wt = realpathSync(mkdtempSync(path.join(tmpdir(), "eslint-lsp-wt-")));
});

afterEach(async () => {
  await manager.destroy();
  setRepoTrusted(wt, false);
  rmSync(wt, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("in an untrusted repository", () => {
  test("nothing runs, and the client gets a server with no features", async () => {
    const socket = start(LAUNCH);
    const { result } = await socket.next(isInitializeResponse);
    expect(result).toEqual({ capabilities: { textDocumentSync: { openClose: true, change: 0 } } });
    expect(manager.lookups).toBe(0);
  });

  test("what is held back is reported only for a project with an ESLint config", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    open(socket, write("a.js"));
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
    write("eslint.config.js");
    open(socket, write("b.js"));
    const [restriction] = getRepoTrustStatus(wt).restrictions;
    expect(restriction).toStartWith(RESTRICTION);
  });

  test("trusting it restarts the connection", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    setRepoTrusted(wt, true);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });
});

describe("in a trusted repository", () => {
  beforeEach(() => {
    setRepoTrusted(wt, true);
  });

  test("when revoked while deciding, nothing starts", async () => {
    const { promise, resolve } = Promise.withResolvers<EslintLaunch>();
    const socket = start(promise);
    setRepoTrusted(wt, false);
    resolve(LAUNCH);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
    expect(socket.frames).toEqual([]);
  });

  test("a held connection without a notice stays quiet in a project with an ESLint config", async () => {
    const socket = start({ notice: null });
    await socket.next(isInitializeResponse);
    write("eslint.config.js");
    open(socket, write("a.js"));
    send(socket, { id: 2, method: "shutdown" });
    await socket.next((frame) => frame.id === 2);
    expect(socket.frames.some((frame) => frame.method === "window/showMessage")).toBe(false);
  });

  test("with no way to run, a project with an ESLint config is told what is missing", async () => {
    const socket = start({ notice: "needs Node" });
    await socket.next(isInitializeResponse);
    open(socket, write("a.js"));
    write("eslint.config.js");
    open(socket, write("b.js"));
    const { params } = await socket.next((frame) => frame.method === "window/showMessage");
    expect(String(params?.message)).toContain("needs Node");
    expect(socket.frames.filter((frame) => frame.method === "window/showMessage")).toHaveLength(1);
  });

  test("the server takes file URIs and react language ids, and gets its formatting taken away", async () => {
    const socket = start(LAUNCH);
    const { result } = await socket.next(isInitializeResponse);
    expect(result).toEqual({ capabilities: { hoverProvider: true } });
    const file = write("src/a b.tsx");
    const fileUrl = pathToFileURL(file).href;
    const uri = fileUrl.replace("file:///", "loxel://head/");
    send(socket, {
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "tsx", version: 1, text: "loxel://head/text" } },
    });
    const { params } = await socket.received("textDocument/didOpen");
    expect(params?.textDocument).toEqual({
      uri: fileUrl,
      languageId: "typescriptreact",
      version: 1,
      text: "loxel://head/text",
    });
  });

  test("the client gets editor URIs, and text stays as it is", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    const file = `file://${wt}/a.js`;
    const edit = (uri: string) => ({
      documentChanges: [
        { textDocument: { uri, version: 1 }, edits: [{ newText: 'x = "file:///keep"' }] },
      ],
      changes: { [uri]: [{ newText: "file:///keep" }] },
    });
    send(socket, {
      method: "test/send",
      params: { id: 7, method: "workspace/applyEdit", params: { edit: edit(file) } },
    });
    const { params } = await socket.next((frame) => frame.method === "workspace/applyEdit");
    expect(params?.edit).toEqual(edit(`loxel://HEAD${wt}/a.js`));
  });

  test("each file's settings say whether it is linted", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    const plain = write("plain/a.js");
    write("uses/eslint.config.js");
    const uninstalled = write("uses/a.js");
    write("linted/eslint.config.js");
    write("linted/node_modules/eslint/package.json", "{}");
    const linted = write("linted/a.js");
    const answerOf = async (id: string, file: string) => {
      const items = [{ scopeUri: `file://${file}`, section: "" }];
      send(socket, {
        method: "test/send",
        params: { id, method: "workspace/configuration", params: { items } },
      });
      const frame = await socket.next((f) => {
        if (f.method !== "test/received") return false;
        return (JSON.parse(String(f.params?.json)) as Frame).id === id;
      });
      const { result } = JSON.parse(String(frame.params?.json)) as { result: Frame[] };
      return result[0] as unknown as { validate: string; workspaceFolder: { name: string } };
    };
    expect((await answerOf("plain", plain)).validate).toBe("off");
    expect((await answerOf("uninstalled", uninstalled)).validate).toBe("off");
    const answer = await answerOf("linted", linted);
    expect(answer.validate).toBe("on");
    expect(answer.workspaceFolder.name).toBe(path.basename(wt));
    const messages = socket.frames.filter((frame) => frame.method === "window/showMessage");
    expect(messages.map((frame) => frame.params?.message)).toEqual([
      "uses has a config, but ESLint isn't installed. Run `npm install --save-dev eslint` in that folder.",
    ]);
  });

  test("the extension's own requests get null, its notifications stop here, and a failed lint is told", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    const answered = (id: string) =>
      socket.next((frame) => {
        if (frame.method !== "test/received") return false;
        return (JSON.parse(String(frame.params?.json)) as Frame).id === id;
      });
    send(socket, { method: "test/send", params: { id: "request", method: "eslint/noConfig" } });
    const answer = JSON.parse(String((await answered("request")).params?.json)) as Frame;
    expect(answer.result).toBeNull();
    const status = (state: number) =>
      send(socket, { method: "test/send", params: { method: "eslint/status", params: { state } } });
    status(1);
    status(3);
    send(socket, { method: "test/send", params: { method: "test/last" } });
    await socket.next((frame) => frame.method === "test/last");
    const methods = socket.frames.map((frame) => frame.method);
    expect(methods).not.toContain("eslint/status");
    expect(methods.filter((method) => method === "window/showMessage")).toHaveLength(1);
    expect(methods).not.toContain("eslint/noConfig");
  });

  test("an install in node_modules restarts the server, which keeps what it loaded", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "src/a.js")]);
    manager.notifyWatchedFilesChanged(wt, [path.join(wt, "node_modules/eslint/package.json")]);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("a change of Node restarts the server, and no change leaves it", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    for (const listener of nodeListeners) listener({ env: { nodePath: process.execPath } });
    send(socket, { method: "test/send", params: { method: "test/alive" } });
    await socket.next((frame) => frame.method === "test/alive");
    for (const listener of nodeListeners) listener({ env: { nodePath: "/other/node" } });
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("a Node appearing restarts a held connection", async () => {
    const socket = start({ notice: "needs Node" });
    await socket.next(isInitializeResponse);
    for (const listener of nodeListeners) listener({ env: { nodePath: process.execPath } });
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("revoking trust stops the server", async () => {
    const socket = start(LAUNCH);
    await socket.next(isInitializeResponse);
    setRepoTrusted(wt, false);
    expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
  });
});
