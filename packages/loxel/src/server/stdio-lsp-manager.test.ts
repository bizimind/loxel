import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket, Subprocess } from "bun";

import { FileChangeType } from "./lsp-watched-files";
import { StdioLspManager, type WtLspContext, type WtLspSession } from "./stdio-lsp-manager";

// A stand-in language server: echoes every frame it reads back as a `test/received`
// notification, and writes whatever a `test/emit` notification carries as its own frame.
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

  protected resolveBinary(): string {
    return process.execPath;
  }

  protected override spawnArgs(): readonly string[] {
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

/** The WebSocket side: frames the client got, and frames the fake server reported reading. */
class FakeClient {
  readonly toClient: Frame[] = [];
  readonly toServer: Frame[] = [];
  readonly ws: ServerWebSocket<unknown>;
  private waiters: Array<() => void> = [];

  constructor(private readonly manager: FakeLspManager) {
    const ws = {
      send: (data: string) => {
        const frame = JSON.parse(data) as Frame;
        if (frame.method === "test/received") this.toServer.push(frame.params as Frame);
        else this.toClient.push(frame);
        for (const wake of this.waiters.splice(0)) wake();
        return data.length;
      },
      close: () => {},
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

async function setup(): Promise<{ client: FakeClient; root: string }> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "stdio-lsp-manager-")));
  const script = join(dir, "fake-server.mjs");
  await writeFile(script, FAKE_SERVER);
  const root = join(dir, "wt");
  manager = new FakeLspManager(script);
  const client = new FakeClient(manager);
  manager.start(client.ws, root);
  return { client, root };
}

const WATCHED_FILES = "workspace/didChangeWatchedFiles";

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
      changes: [{ uri: pathToFileURL(join(root, "main.py")).href, type: FileChangeType.Created }],
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
