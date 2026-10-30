import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket, Subprocess } from "bun";

import { LSP_EXITED_CLOSE_CODE, LSP_START_FAILED_CLOSE_CODE } from "@/api/ws-protocol";

import { FileChangeType } from "./lsp-watched-files";
import { StdioLspManager, type WtLspContext, type WtLspSession } from "./stdio-lsp-manager";

// A stand-in language server: echoes every frame it reads back as a `test/received`
// notification, writes whatever a `test/emit` notification carries as its own frame, exits with
// the code a `test/exit` notification carries, kills itself on `test/kill`, and fills a `test/argv`
// notification with its arguments.
const FAKE_SERVER = `
let buf = Buffer.alloc(0);
const write = (msg) => {
  const body = Buffer.from(JSON.stringify(msg));
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
    if (msg.method === "test/exit") process.exit(msg.params.code);
    if (msg.method === "test/kill") process.kill(process.pid, "SIGKILL");
    if (msg.method === "test/argv") msg.params = { argv: process.argv };
    if (msg.method === "test/emit") write(msg.params);
    else write({ jsonrpc: "2.0", method: "test/received", params: msg });
  }
}
`;

interface Frame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

class FakeLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
  protected override readonly forwardWatchedFiles = true;

  constructor(private readonly script: string) {
    super("python-lsp");
  }

  start(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  protected resolveBinary(): string | null {
    return process.execPath;
  }

  protected override spawnArgs(_context: WtLspContext): readonly string[] {
    return [this.script];
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionWorkspace(session: WtLspSession): string {
    return session.wtPath;
  }
}

class OptInLspManager extends FakeLspManager {
  protected override readonly watchedFileGlobs = ["**/.eslintrc*"];
  protected override readonly watchedIgnoredGlobs = ["build/compile_commands.json"];
  protected override readonly didSaveOnFileChange = true;

  protected override workspaceConfiguration(
    _session: WtLspSession,
    section: string | undefined,
    scopeUri: string | undefined,
  ): Promise<unknown> {
    return Promise.resolve({ section, scopeUri });
  }
}

/** The WebSocket side: frames the client got, and frames the fake server reported reading. */
class FakeClient {
  readonly toClient: Frame[] = [];
  readonly toServer: Frame[] = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  readonly ws: ServerWebSocket<unknown>;
  /** Resolves with the code of the manager's first `close()` of the socket. */
  readonly closed: Promise<number | undefined>;
  private waiters: Array<() => void> = [];

  constructor(private readonly manager: FakeLspManager) {
    const { promise, resolve } = Promise.withResolvers<number | undefined>();
    this.closed = promise;
    const ws = {
      send: (data: string) => {
        const frame = JSON.parse(data) as Frame;
        if (frame.method === "test/received") this.toServer.push(frame.params as Frame);
        else this.toClient.push(frame);
        for (const wake of this.waiters.splice(0)) wake();
        return data.length;
      },
      close: (code?: number, reason?: string) => {
        this.closes.push([code, reason]);
        resolve(code);
      },
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  send(frame: Frame): void {
    this.manager.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...frame }));
  }

  /** Make the server send `frame` to the client. */
  emit(frame: Frame): void {
    this.send({ method: "test/emit", params: { jsonrpc: "2.0", ...frame } as Frame["params"] });
  }

  async serverReceived(match: (frame: Frame) => boolean): Promise<Frame> {
    return this.waitFor(() => this.toServer.find(match));
  }

  private async waitFor(find: () => Frame | undefined): Promise<Frame> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = find();
      if (found) return found;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
    throw new Error("timed out waiting for a frame");
  }
}

let dir: string | undefined;
let manager: FakeLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function setup(
  wtName = "wt",
  create: (script: string) => FakeLspManager = (script) => new FakeLspManager(script),
): Promise<{ client: FakeClient; root: string }> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "stdio-lsp-manager-")));
  const script = join(dir, "fake-server.mjs");
  await writeFile(script, FAKE_SERVER);
  const root = join(dir, wtName);
  manager = create(script);
  const client = new FakeClient(manager);
  manager.start(client.ws, root);
  return { client, root };
}

const WATCHED_FILES = "workspace/didChangeWatchedFiles";

describe("StdioLspManager workspace root", () => {
  test("sends the worktree as a percent-encoded file URI, whatever its name holds", async () => {
    const { client, root } = await setup("my wt #1 50% ü");
    client.send({ id: 1, method: "initialize", params: { capabilities: {}, rootUri: null } });
    const init = await client.serverReceived((f) => f.method === "initialize");
    const uri = pathToFileURL(root).href;
    expect(uri).toEndWith("/my%20wt%20%231%2050%25%20%C3%BC");
    expect(init.params?.rootUri).toBe(uri);
    expect(init.params?.rootPath).toBe(root);
    expect(init.params?.workspaceFolders).toEqual([{ uri, name: "my wt #1 50% ü" }]);
  });
});

describe("StdioLspManager watched files", () => {
  test("advertises the client capability in initialize", async () => {
    const { client } = await setup();
    client.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    const init = await client.serverReceived((f) => f.method === "initialize");
    expect(init.params?.capabilities).toEqual({
      workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
    });
  });

  test("answers watcher registrations itself and forwards matching changes", async () => {
    const { client, root } = await setup();
    await mkdir(root);
    await writeFile(join(root, "main.py"), "x = 1\n");

    client.emit({
      id: 7,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "w1",
            method: WATCHED_FILES,
            registerOptions: { watchers: [{ globPattern: "**/*.py" }] },
          },
        ],
      },
    });
    const ack = await client.serverReceived((f) => f.id === 7);
    expect(ack.result).toBeNull();

    manager!.notifyWatchedFilesChanged(root, [join(root, "main.py"), join(root, "notes.txt")]);
    manager!.notifyWatchedFilesChanged(join(dir!, "other"), [join(dir!, "other", "x.py")]);
    const changed = await client.serverReceived((f) => f.method === WATCHED_FILES);
    expect(changed.params).toEqual({
      changes: [FileChangeType.Changed, FileChangeType.Created].map((type) => ({
        uri: pathToFileURL(join(root, "main.py")).href,
        type,
      })),
    });

    client.emit({
      id: 8,
      method: "client/unregisterCapability",
      params: { unregisterations: [{ id: "w1", method: WATCHED_FILES }] },
    });
    await client.serverReceived((f) => f.id === 8);
    manager!.notifyWatchedFilesChanged(root, [join(root, "gone.py")]);
    await Bun.sleep(400);
    expect(client.toServer.filter((f) => f.method === WATCHED_FILES)).toHaveLength(1);
    // Nothing about watched files ever reached the client.
    expect(client.toClient).toEqual([]);
  });

  test("delivers changes reported before the server registered its watchers", async () => {
    const { client, root } = await setup();
    await mkdir(root);
    await writeFile(join(root, "early.py"), "x = 1\n");
    manager!.notifyWatchedFilesChanged(root, [join(root, "early.py")]);

    client.emit({
      id: 7,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "w1",
            method: WATCHED_FILES,
            registerOptions: { watchers: [{ globPattern: "**" }] },
          },
        ],
      },
    });
    const changed = await client.serverReceived((f) => f.method === WATCHED_FILES);
    expect(changed.params).toEqual({
      changes: [FileChangeType.Changed, FileChangeType.Created].map((type) => ({
        uri: pathToFileURL(join(root, "early.py")).href,
        type,
      })),
    });
  });

  test("passes the other registrations of a mixed request on to the client", async () => {
    const { client } = await setup();
    client.emit({
      id: 9,
      method: "client/registerCapability",
      params: {
        registrations: [
          { id: "w1", method: WATCHED_FILES, registerOptions: { watchers: [] } },
          { id: "c1", method: "workspace/didChangeConfiguration", registerOptions: {} },
        ],
      },
    });
    const deadline = Date.now() + 5000;
    while (client.toClient.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(client.toClient).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        method: "client/registerCapability",
        params: {
          registrations: [
            { id: "c1", method: "workspace/didChangeConfiguration", registerOptions: {} },
          ],
        },
      } as Frame,
    ]);
  });
});

describe("StdioLspManager opt-in hooks", () => {
  const DID_SAVE = "textDocument/didSave";
  const setupOptIn = () => setup("wt", (script) => new OptInLspManager(script));
  let marks = 0;
  /** Everything sent before now has been read once the server echoes this. */
  async function drained(client: FakeClient): Promise<void> {
    const mark = `test/mark-${++marks}`;
    client.send({ method: mark });
    await client.serverReceived((f) => f.method === mark);
  }

  test("workspaceConfiguration receives the request's scopeUri", async () => {
    const { client } = await setupOptIn();
    client.emit({
      id: 5,
      method: "workspace/configuration",
      params: { items: [{ scopeUri: "file:///wt/a.ts", section: "" }, { section: "x" }] },
    });
    const answer = await client.serverReceived((f) => f.id === 5);
    expect(answer.result).toEqual([{ section: "", scopeUri: "file:///wt/a.ts" }, { section: "x" }]);
  });

  test("declared globs forward changes for a server that registers no watchers", async () => {
    const { client, root } = await setupOptIn();
    await mkdir(root);
    await writeFile(join(root, ".eslintrc.json"), "{}");
    client.send({ method: "initialized", params: {} });
    manager!.notifyWatchedFilesChanged(root, [join(root, ".eslintrc.json"), join(root, "a.ts")]);
    const changed = await client.serverReceived((f) => f.method === WATCHED_FILES);
    expect(changed.params?.changes).toEqual(
      [FileChangeType.Changed, FileChangeType.Created].map((type) => ({
        uri: pathToFileURL(join(root, ".eslintrc.json")).href,
        type,
      })),
    );
  });

  test("ignored paths are forwarded only when a manager's ignored globs ask for them", async () => {
    const { client, root } = await setupOptIn();
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build", "compile_commands.json"), "[]");
    client.send({ method: "initialized", params: {} });
    // On another worktree, and not asked for: neither may reach the batch below.
    manager!.notifyIgnoredPathChanged(join(dir!, "other"), "build/compile_commands.json");
    manager!.notifyIgnoredPathChanged(root, "build/main.o");
    manager!.notifyIgnoredPathChanged(root, "node_modules/x/.eslintrc.json");
    manager!.notifyIgnoredPathChanged(root, "build/compile_commands.json");
    const changed = await client.serverReceived((f) => f.method === WATCHED_FILES);
    expect(changed.params?.changes).toEqual(
      [FileChangeType.Changed, FileChangeType.Created].map((type) => ({
        uri: pathToFileURL(join(root, "build", "compile_commands.json")).href,
        type,
      })),
    );
  });

  test("a manager that did not opt in drops ignored paths and sends no didSave", async () => {
    const { client, root } = await setup();
    await mkdir(root);
    await writeFile(join(root, "a.c"), "");
    const uri = pathToFileURL(join(root, "a.c")).href;
    client.send({ method: "textDocument/didOpen", params: { textDocument: { uri, text: "" } } });
    client.emit({
      id: 7,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "w1",
            method: WATCHED_FILES,
            registerOptions: { watchers: [{ globPattern: "**" }] },
          },
        ],
      },
    });
    await client.serverReceived((f) => f.id === 7);
    manager!.notifyIgnoredPathChanged(root, "build/compile_commands.json");
    manager!.notifyWatchedFilesChanged(root, [join(root, "a.c")]);
    const changed = await client.serverReceived((f) => f.method === WATCHED_FILES);
    // Its server's `**` watcher would have matched the ignored path, had it been forwarded.
    expect(changed.params?.changes).toEqual(
      [FileChangeType.Changed, FileChangeType.Created].map((type) => ({ uri, type })),
    );
    expect(client.toServer.some((f) => f.method === DID_SAVE)).toBe(false);
  });

  test("didSave goes out for changed open documents, until they close", async () => {
    const { client, root } = await setupOptIn();
    const open = pathToFileURL(join(root, "a b.c")).href;
    client.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri: open, text: "" } },
    });
    await drained(client);

    manager!.notifyWatchedFilesChanged(join(dir!, "other"), [join(root, "a b.c")]);
    manager!.notifyWatchedFilesChanged(root, [join(root, "closed.c"), join(root, "a b.c")]);
    const saved = await client.serverReceived((f) => f.method === DID_SAVE);
    expect(saved.params).toEqual({ textDocument: { uri: open } });
    await drained(client);
    expect(client.toServer.filter((f) => f.method === DID_SAVE)).toHaveLength(1);

    client.send({ method: "textDocument/didClose", params: { textDocument: { uri: open } } });
    await drained(client);
    manager!.notifyWatchedFilesChanged(root, [join(root, "a b.c")]);
    await drained(client);
    expect(client.toServer.filter((f) => f.method === DID_SAVE)).toHaveLength(1);
  });
});

describe("StdioLspManager context hooks", () => {
  class ContextLspManager extends FakeLspManager {
    constructor(
      script: string,
      private readonly failure: string | null,
      private readonly bin: string | null = process.execPath,
    ) {
      super(script);
    }

    protected override resolveBinary(): string | null {
      return this.bin;
    }

    protected override spawnArgs(context: WtLspContext): readonly string[] {
      return [...super.spawnArgs(context), context.wtPath];
    }

    protected override serverFailureReason(): string | null {
      return this.failure;
    }
  }

  test("spawnArgs receives the session's context", async () => {
    const { client, root } = await setup("wt", (script) => new ContextLspManager(script, null));
    client.send({ method: "test/argv" });
    const argv = await client.serverReceived((f) => f.method === "test/argv");
    expect(argv.params?.argv).toContain(root);
  });

  test("a server that cannot start closes with the manager's reason, cut to fit", async () => {
    const reason = "é".repeat(100);
    const { client } = await setup("wt", (script) => new ContextLspManager(script, reason, null));
    expect(await client.closed).toBe(LSP_START_FAILED_CLOSE_CODE);
    expect(client.closes[0]?.[1]).toBe("é".repeat(61));
  });

  test("a failure-reason hook that throws still closes the socket", async () => {
    class ThrowingLspManager extends ContextLspManager {
      protected override serverFailureReason(): string | null {
        throw new Error("boom");
      }
    }
    const { client } = await setup("wt", (script) => new ThrowingLspManager(script, null, null));
    expect(await client.closed).toBe(LSP_START_FAILED_CLOSE_CODE);
  });

  test("a server that exits closes with the manager's reason", async () => {
    const { client } = await setup("wt", (script) => new ContextLspManager(script, "see the log"));
    client.send({ method: "test/exit", params: { code: 3 } });
    expect(await client.closed).toBe(LSP_EXITED_CLOSE_CODE);
    expect(client.closes).toEqual([[LSP_EXITED_CLOSE_CODE, "see the log"]]);
  });
});

describe("StdioLspManager workspace folders", () => {
  test("answers workspace/workspaceFolders with the session's worktree", async () => {
    const { client, root } = await setup();
    client.emit({ id: 9, method: "workspace/workspaceFolders" });
    const answer = await client.serverReceived((f) => f.id === 9);
    expect(answer.result).toEqual([{ uri: `file://${root}`, name: "wt" }]);
    expect(client.toClient).toEqual([]);
  });
});

describe("StdioLspManager spawn failures", () => {
  /** A server keyed by worktree whose binary lost its execute bit, so `Bun.spawn` throws. */
  class UnexecutableLspManager extends FakeLspManager {
    constructor(private readonly bin: string) {
      super(bin);
    }

    protected override resolveBinary(): string {
      return this.bin;
    }

    protected override getSessionKey(context: WtLspContext): string {
      return context.wtPath;
    }
  }

  test("a binary that cannot run closes the socket and frees the worktree's session", async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "stdio-lsp-manager-")));
    const bin = join(dir, "server");
    await writeFile(bin, "#!/bin/sh\n", { mode: 0o644 });
    manager = new UnexecutableLspManager(bin);
    const first = new FakeClient(manager);

    manager.start(first.ws, dir);
    expect(first.closes).toEqual([[LSP_START_FAILED_CLOSE_CODE, "python-lsp failed to start"]]);

    // The next connection for the worktree finds no session left to replace.
    manager.start(new FakeClient(manager).ws, dir);
    expect(first.closes).toHaveLength(1);
  });
});

describe("StdioLspManager process exit", () => {
  class KeyedLspManager extends FakeLspManager {
    /** Every `onSessionClosed` call; the exit handler makes one after it decides on closing. */
    sessionCloses = 0;
    private closeWaiters: Array<() => void> = [];

    protected override getSessionKey(context: WtLspContext): string {
      return context.wtPath;
    }

    protected override onSessionClosed(): void {
      this.sessionCloses += 1;
      for (const wake of this.closeWaiters.splice(0)) wake();
    }

    async untilSessionCloses(count: number): Promise<void> {
      while (this.sessionCloses < count) {
        await new Promise<void>((resolve) => {
          this.closeWaiters.push(resolve);
        });
      }
    }
  }

  async function setupKeyed(): Promise<{
    client: FakeClient;
    root: string;
    keyed: KeyedLspManager;
  }> {
    dir = await realpath(await mkdtemp(join(tmpdir(), "stdio-lsp-manager-")));
    const script = join(dir, "fake-server.mjs");
    await writeFile(script, FAKE_SERVER);
    const keyed = new KeyedLspManager(script);
    manager = keyed;
    const client = new FakeClient(keyed);
    keyed.start(client.ws, dir);
    return { client, root: dir, keyed };
  }

  test("a server that exits on its own closes the socket and frees the worktree's session", async () => {
    const { client, root } = await setupKeyed();
    client.send({ method: "test/exit", params: { code: 3 } });

    expect(await client.closed).toBe(LSP_EXITED_CLOSE_CODE);
    expect(client.closes).toEqual([[LSP_EXITED_CLOSE_CODE, "python-lsp exited with code 3"]]);

    // The reconnect gets a new server, without replacing (closing) the gone socket again.
    const next = new FakeClient(manager!);
    manager!.start(next.ws, root);
    next.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    await next.serverReceived((f) => f.method === "initialize");
    expect(client.closes).toHaveLength(1);
  });

  test("names the signal that killed the server", async () => {
    const { client } = await setupKeyed();
    client.send({ method: "test/kill" });

    expect(await client.closed).toBe(LSP_EXITED_CLOSE_CODE);
    expect(client.closes).toEqual([[LSP_EXITED_CLOSE_CODE, "python-lsp was killed by SIGKILL"]]);
  });

  test("a server stopped by detach does not close the socket", async () => {
    const { client, keyed } = await setupKeyed();
    client.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    await client.serverReceived((f) => f.method === "initialize");

    keyed.detach(client.ws);
    expect(keyed.sessionCloses).toBe(1);
    // The second is the exit handler's, which decides about closing the socket in the same step.
    await keyed.untilSessionCloses(2);

    expect(client.closes).toEqual([]);
  });
});
