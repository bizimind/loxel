import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

import { TsLspManager, toClientUris, toServerUris } from "./ts-lsp-manager";
import { resolveTypeScriptBinary } from "./typescript-path";

describe("toServerUris", () => {
  test("translates TS/JS editor model URIs in any authority casing", () => {
    const body = JSON.stringify({
      params: { textDocument: { uri: "loxel://head/repo/src/a.ts" }, other: "loxel://HEAD/b.tsx" },
    });
    expect(JSON.parse(toServerUris(body))).toEqual({
      params: { textDocument: { uri: "file:///repo/src/a.ts" }, other: "file:///b.tsx" },
    });
  });

  test("leaves file:// JSON models and other loxel authorities alone", () => {
    const body = JSON.stringify({
      a: "file:///repo/package.json",
      b: "loxel://abc123/src/a.ts#old",
      c: "loxel://compare/repo/a.ts#p-new",
    });
    expect(toServerUris(body)).toBe(body);
  });
});

describe("toClientUris", () => {
  test("maps TS/JS files to loxel://HEAD and keeps JSON files on file://", () => {
    const body = JSON.stringify({
      changes: {
        "file:///repo/src/a.ts": [],
        "file:///repo/node_modules/x/index.d.ts": [],
        "file:///repo/package.json": [],
        "file:///repo/tsconfig.base.JSONC": [],
      },
    });
    expect(Object.keys(JSON.parse(toClientUris(body)).changes)).toEqual([
      "loxel://HEAD/repo/src/a.ts",
      "loxel://HEAD/repo/node_modules/x/index.d.ts",
      "file:///repo/package.json",
      "file:///repo/tsconfig.base.JSONC",
    ]);
  });

  test("keeps percent-encoded paths intact", () => {
    const body = JSON.stringify({ uri: "file:///my%20repo/a%40b.ts" });
    expect(JSON.parse(toClientUris(body))).toEqual({ uri: "loxel://HEAD/my%20repo/a%40b.ts" });
  });

  test("decides by the path, not a query, fragment or trailing markdown", () => {
    const value =
      "[a](file:///repo/a.ts#L3,5) [b](file:///repo/b.json#L1) see file:///repo/c.js?x=1.json";
    const body = JSON.stringify({ contents: { value } });
    expect(JSON.parse(toClientUris(body)).contents.value).toBe(
      "[a](loxel://HEAD/repo/a.ts#L3,5) [b](file:///repo/b.json#L1) see loxel://HEAD/repo/c.js?x=1.json",
    );
  });

  test("round-trips TS/JS URIs", () => {
    const body = JSON.stringify({ uri: "loxel://HEAD/repo/src/a.ts" });
    expect(toClientUris(toServerUris(body))).toBe(body);
  });
});

// Drives the real `tsc --lsp` through the manager the way the Monaco client does.

const TEST_TIMEOUT_MS = 60_000;
/** Generous: CI runners can be slow to load the project and register tsc's watchers. */
const RESOLVE_DEADLINE_MS = 40_000;
const MISSING_MODULE = "Cannot find module './b'";

let root: string | undefined;
let manager: TsLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  /** Server→client requests that reached the client. */
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private readonly responses = new Map<number, (result: unknown) => void>();
  private nextId = 1;

  constructor(private readonly manager: TsLspManager) {
    const ws = {
      send: (data: string) => {
        this.receive(data);
        return data.length;
      },
      close: () => {},
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  async start(wtPath: string): Promise<void> {
    this.manager.createSession(this.ws, wtPath);
    await this.request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: { textDocument: { diagnostic: {} } },
    });
    this.send({ method: "initialized", params: {} });
  }

  open(filePath: string, text: string): string {
    const uri = `loxel://HEAD${filePath}`;
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "typescript", version: 1, text } },
    });
    return uri;
  }

  async diagnosticMessages(uri: string): Promise<string[]> {
    const result = (await this.request("textDocument/diagnostic", { textDocument: { uri } })) as {
      items?: Array<{ message: string }>;
    } | null;
    return result?.items?.map((d) => d.message) ?? [];
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.responses.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.manager.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(data: string): void {
    const message = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
    };
    if (message.method !== undefined && message.id !== undefined) {
      this.requests.push({ method: message.method, params: message.params });
      this.send({ id: message.id, result: null });
      return;
    }
    if (message.id !== undefined) this.responses.get(message.id)?.(message.result);
  }
}

describe.skipIf(resolveTypeScriptBinary() === null)("TsLspManager with tsc --lsp", () => {
  test(
    "resolves a module created on disk once the file watcher reports it",
    async () => {
      // Upper case in the path: tsc registers its watchers lowercased on case-insensitive disks.
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLsp-")));
      await mkdir(join(root, "src"));
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
      const source = 'import { y } from "./b";\nexport const x: number = y;\n';
      await writeFile(join(root, "src", "a.ts"), source);

      manager = new TsLspManager();
      const client = new FakeClient(manager);
      await client.start(root);
      const uri = client.open(join(root, "src", "a.ts"), source);
      expect((await client.diagnosticMessages(uri)).join("\n")).toContain(MISSING_MODULE);

      const created = join(root, "src", "b.ts");
      await writeFile(created, "export const y = 1;\n");

      // tsc may not have registered its watchers yet (it does once the project has loaded); the
      // manager keeps the change until it does.
      manager.notifyWatchedFilesChanged(root, [created]);

      const deadline = Date.now() + RESOLVE_DEADLINE_MS;
      let messages = await client.diagnosticMessages(uri);
      while (messages.some((m) => m.includes(MISSING_MODULE)) && Date.now() < deadline) {
        await Bun.sleep(200);
        messages = await client.diagnosticMessages(uri);
      }
      expect(messages).toEqual([]);
      // The watcher registrations were answered by the manager, not passed to the client.
      const registered = client.requests.flatMap((r) =>
        r.method === "client/registerCapability"
          ? (r.params as { registrations: Array<{ method: string }> }).registrations
          : [],
      );
      expect(registered.map((r) => r.method)).not.toContain("workspace/didChangeWatchedFiles");
    },
    TEST_TIMEOUT_MS,
  );
});
