import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { DOCUMENT_INDENTATION_METHOD, type DocumentIndentation } from "@/api/lsp-indentation-model";

import type { WtLspSession } from "./stdio-lsp-manager";
import { setReactLanguageId, TsLspManager, toClientUris, toServerUris } from "./ts-lsp-manager";
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

describe("setReactLanguageId", () => {
  test("gives .tsx and .jsx documents TypeScript's JSX language ids", () => {
    const tsx = { textDocument: { uri: "loxel://HEAD/a/B.TSX", languageId: "tsx" } };
    expect(setReactLanguageId(tsx)).toBe(true);
    expect(tsx.textDocument.languageId).toBe("typescriptreact");
    const jsx = { textDocument: { uri: "loxel://HEAD/a/b.jsx", languageId: "jsx" } };
    expect(setReactLanguageId(jsx)).toBe(true);
    expect(jsx.textDocument.languageId).toBe("javascriptreact");
  });

  test("goes by the language id for a file without a React extension", () => {
    const params = { textDocument: { uri: "loxel://HEAD/a/b.foo", languageId: "tsx" } };
    expect(setReactLanguageId(params)).toBe(true);
    expect(params.textDocument.languageId).toBe("typescriptreact");
  });

  test("leaves other documents and correct ids alone", () => {
    expect(setReactLanguageId({ textDocument: { uri: "loxel://HEAD/a.ts" } })).toBe(false);
    const ok = { textDocument: { uri: "loxel://HEAD/a.tsx", languageId: "typescriptreact" } };
    expect(setReactLanguageId(ok)).toBe(false);
    expect(setReactLanguageId(null)).toBe(false);
  });
});

// Drives the real `tsc --lsp` through the manager the way the Monaco client does.

const TEST_TIMEOUT_MS = 60_000;
/** Generous: CI runners can be slow to load the project and register tsc's watchers. */
const RESOLVE_DEADLINE_MS = 40_000;
const MISSING_MODULE = "Cannot find module './b'";
/** "Class 'C' incorrectly implements interface 'I'." */
const CLASS_INCORRECTLY_IMPLEMENTS = 2420;

let root: string | undefined;
let manager: TsLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

interface Diagnostic {
  message: string;
  code?: number | string;
  range: unknown;
}

/** Records what the manager writes to the server. */
class RecordingTsLspManager extends TsLspManager {
  readonly written: Array<{ method?: string; params?: unknown; id?: unknown; result?: unknown }> =
    [];

  protected override writeToStdin(session: WtLspSession, data: string): void {
    this.written.push(JSON.parse(data) as (typeof this.written)[number]);
    super.writeToStdin(session, data);
  }

  /** What the manager does with a frame from the server. */
  serverFrame(ws: ServerWebSocket<unknown>, body: unknown): void {
    const session = this.sessionOf(ws);
    this.handleServerFrame(session, JSON.stringify(body));
  }

  forwarded(method: string): unknown[] {
    return this.written.filter((m) => m.method === method).map((m) => m.params);
  }

  private sessionOf(ws: ServerWebSocket<unknown>): WtLspSession {
    const session = this.sessions.get(ws);
    if (!session) throw new Error("No session for this socket");
    return session;
  }
}

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

  open(filePath: string, text: string, languageId = "typescript"): string {
    // Percent-encoded, as Monaco's `Uri.toString()` writes it.
    const uri = `loxel://HEAD${pathToFileURL(filePath).pathname}`;
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId, version: 1, text } },
    });
    return uri;
  }

  change(uri: string, version: number, text: string): void {
    this.send({
      method: "textDocument/didChange",
      params: { textDocument: { uri, version }, contentChanges: [{ text }] },
    });
  }

  close(uri: string): void {
    this.send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
  }

  async hover(uri: string, line: number, character: number): Promise<string> {
    const result = (await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    })) as { contents?: { value?: string } } | null;
    return result?.contents?.value ?? "";
  }

  /** The URIs of the definitions of the symbol at a position. */
  async definitions(uri: string, line: number, character: number): Promise<string[]> {
    const result = (await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    })) as Array<{ uri: string }> | null;
    return (result ?? []).map((d) => d.uri);
  }

  /** What `reportDocumentIndentation` sends for a model. */
  indent(uri: string, indentation: DocumentIndentation): void {
    this.send({
      method: DOCUMENT_INDENTATION_METHOD,
      params: { textDocument: { uri }, indentation },
    });
  }

  async diagnostics(uri: string): Promise<Diagnostic[]> {
    const result = (await this.request("textDocument/diagnostic", { textDocument: { uri } })) as {
      items?: Diagnostic[];
    } | null;
    return result?.items ?? [];
  }

  async diagnosticMessages(uri: string): Promise<string[]> {
    return (await this.diagnostics(uri)).map((d) => d.message);
  }

  async codeActions(uri: string): Promise<unknown> {
    const start = { line: 0, character: 0 };
    return this.request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start, end: start },
      context: { diagnostics: [] },
    });
  }

  /** The text each edit of the code action titled `title` inserts, for the diagnostic `code`. */
  async codeActionEdits(uri: string, code: number, title: string): Promise<string[]> {
    const diagnostic = (await this.diagnostics(uri)).find((d) => d.code === code);
    if (!diagnostic) throw new Error(`No diagnostic ${code} in ${uri}`);
    const actions = (await this.request("textDocument/codeAction", {
      textDocument: { uri },
      range: diagnostic.range,
      context: { diagnostics: [diagnostic] },
    })) as Array<{
      title: string;
      edit?: { changes?: Record<string, Array<{ newText: string }>> };
    }>;
    const action = actions.find((a) => a.title === title);
    if (!action) throw new Error(`No code action "${title}": ${actions.map((a) => a.title)}`);
    return Object.values(action.edit?.changes ?? {}).flatMap((edits) =>
      edits.map((e) => e.newText),
    );
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
      // `#`, `%`, a space and a non-ASCII letter: the root and documents must reach tsc encoded.
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLsp #1 50% ü-")));
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

  test(
    "gives an extensionless script language features, as long as it is open",
    async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLspScript-")));
      await mkdir(join(root, "bin"));
      const script = join(root, "bin", "www");
      const text = "#!/usr/bin/env node\nconst port = 3000;\nconsole.log(port);\n";
      await writeFile(script, text);

      const recording = new RecordingTsLspManager();
      manager = recording;
      const client = new FakeClient(recording);
      await client.start(root);
      const uri = client.open(script, text, "javascript");
      expect(await client.hover(uri, 2, 13)).toContain("port");
      expect(await client.definitions(uri, 2, 13)).toEqual([uri]);

      // `didChange` carries no language: it is let through by the `didOpen`.
      client.change(uri, 2, text.replaceAll("port", "host"));
      expect(await client.hover(uri, 2, 13)).toContain("host");

      client.close(uri);
      const before = recording.written.length;
      client.change(uri, 3, text);
      expect(recording.written.length).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "gives a TypeScript shebang script TypeScript's checks",
    async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLspTsScript-")));
      const script = join(root, "tool");
      const text = '#!/usr/bin/env tsx\nconst n: number = "x";\nconsole.log(n);\n';
      await writeFile(script, text);

      manager = new TsLspManager();
      const client = new FakeClient(manager);
      await client.start(root);
      const uri = client.open(script, text, "typescript");
      expect((await client.diagnosticMessages(uri)).join("\n")).toContain(
        "'string' is not assignable to type 'number'",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps files with neither a TS/JS/JSON extension nor a script language from TypeScript",
    async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLspOther-")));
      const recording = new RecordingTsLspManager();
      manager = recording;
      const client = new FakeClient(recording);
      await client.start(root);
      const uri = client.open(join(root, ".babelrc"), "{}", "json");
      client.change(uri, 2, "{ }");
      expect(recording.forwarded("textDocument/didOpen")).toEqual([]);
      expect(recording.forwarded("textDocument/didChange")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "turns automatic type acquisition off in every way TypeScript reads its settings",
    async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLspAta-")));
      const recording = new RecordingTsLspManager();
      manager = recording;
      const client = new FakeClient(recording);
      await client.start(root);
      const off = { automaticTypeAcquisitionEnabled: false };

      expect(recording.forwarded("initialize")).toEqual([
        expect.objectContaining({
          initializationOptions: { userPreferences: expect.objectContaining(off) },
        }),
      ]);

      recording.serverFrame(client.ws, {
        id: "configuration",
        method: "workspace/configuration",
        params: { items: [{ section: "js/ts" }] },
      });
      expect(recording.written.find((m) => m.id === "configuration")?.result).toEqual([
        expect.objectContaining(off),
      ]);

      // The indentation path replaces the section.
      const text = "export const a = 1;\n";
      const uri = client.open(join(root, "a.ts"), text);
      client.indent(uri, { tabSize: 2, indentSize: 2, insertSpaces: true });
      await client.diagnostics(uri);
      await client.codeActions(uri);
      expect(recording.forwarded("workspace/didChangeConfiguration")).toEqual([
        { settings: { "js/ts": expect.objectContaining(off) } },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "indents a quick fix's code like the document it is for",
    async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "TsLspIndent-")));
      await mkdir(join(root, "src"));
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
      const twoSpaces = "interface I {\n  a(): void;\n}\nexport class C implements I {}\n";
      const tabs = "interface I {\n\ta(): void;\n}\nexport class D implements I {}\n";
      await writeFile(join(root, "src", "a.ts"), twoSpaces);
      await writeFile(join(root, "src", "b.tsx"), tabs);

      manager = new TsLspManager();
      const client = new FakeClient(manager);
      await client.start(root);
      const a = client.open(join(root, "src", "a.ts"), twoSpaces);
      const b = client.open(join(root, "src", "b.tsx"), tabs, "tsx");
      client.indent(a, { tabSize: 2, indentSize: 2, insertSpaces: true });
      client.indent(b, { tabSize: 4, indentSize: 4, insertSpaces: false });

      const implementI = "Implement interface 'I'";
      const inA = (await client.codeActionEdits(a, CLASS_INCORRECTLY_IMPLEMENTS, implementI)).join(
        "",
      );
      expect(inA).toContain("\n  a(): void {\n    throw");
      const inB = (await client.codeActionEdits(b, CLASS_INCORRECTLY_IMPLEMENTS, implementI)).join(
        "",
      );
      expect(inB).toContain("\n\ta(): void {\n\t\tthrow");

      // A changed indentation applies to the next request.
      client.indent(a, { tabSize: 8, indentSize: 3, insertSpaces: true });
      const again = (
        await client.codeActionEdits(a, CLASS_INCORRECTLY_IMPLEMENTS, implementI)
      ).join("");
      expect(again).toContain("\n   a(): void {\n      throw");
    },
    TEST_TIMEOUT_MS,
  );
});
