import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { TomlLspManager, tombiSettings, toTombiPatterns } from "./toml-lsp-manager";

describe("toTombiPatterns", () => {
  test("anchors globs at any depth, like Monaco's JSON fileMatch", () => {
    expect(toTombiPatterns("**/pyproject.toml")).toEqual(["**/pyproject.toml"]);
    expect(toTombiPatterns("pyproject.toml")).toEqual(["**/pyproject.toml"]);
    expect(toTombiPatterns("config/*.toml")).toEqual(["**/config/*.toml"]);
    expect(toTombiPatterns("/config/*.toml")).toEqual(["**/config/*.toml"]);
    expect(toTombiPatterns("/")).toEqual([]);
  });

  test("expands brace alternatives, which Tombi does not support", () => {
    expect(toTombiPatterns("**/{ruff,.ruff}.toml")).toEqual(["**/ruff.toml", "**/.ruff.toml"]);
    expect(toTombiPatterns("{a,b}/*.{toml,tml}")).toEqual([
      "**/a/*.toml",
      "**/a/*.tml",
      "**/b/*.toml",
      "**/b/*.tml",
    ]);
  });
});

describe("tombiSettings", () => {
  test("maps each schema URL to its globs, with the catalogs and strict mode off", () => {
    expect(
      tombiSettings({
        "https://json.schemastore.org/pyproject.json": ["**/pyproject.toml"],
        "file:///schemas/app.json": ["app.toml", "**/{dev,prod}.toml"],
      }),
    ).toEqual({
      tombi: {
        schema: { strict: false, catalog: { paths: [] } },
        schemas: [
          { path: "https://json.schemastore.org/pyproject.json", include: ["**/pyproject.toml"] },
          {
            path: "file:///schemas/app.json",
            include: ["**/app.toml", "**/dev.toml", "**/prod.toml"],
          },
        ],
      },
    });
  });
});

// The rest runs the real bundled Tombi (`pnpm run download:tombi`) behind the manager, the way
// Monaco's client talks to it: pull diagnostics, with `workspace/diagnostic/refresh` support.

const BUNDLED_TOMBI = resolve(
  import.meta.dir,
  "../../build",
  process.platform === "win32" ? "tombi.exe" : "tombi",
);
const TEST_TIMEOUT_MS = 30_000;

/** Accepts a string `name` and nothing else. */
const APP_SCHEMA = JSON.stringify({
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: false,
});

interface LspMessage {
  id?: number;
  method?: string;
  result?: unknown;
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  /** Server→client requests that reached the client. */
  readonly serverRequests: string[] = [];
  private nextId = 1;
  private readonly responses = new Map<number, (result: unknown) => void>();

  constructor(private readonly manager: TomlLspManager) {
    const ws = {
      send: (data: string) => {
        this.receive(data);
        return data.length;
      },
      close: () => {},
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  async start(wtPath: string): Promise<{ capabilities: Record<string, unknown> }> {
    this.manager.createSession(this.ws, wtPath);
    const result = await this.request("initialize", {
      processId: null,
      capabilities: {
        textDocument: { diagnostic: { dynamicRegistration: true } },
        workspace: { diagnostics: { refreshSupport: true } },
      },
    });
    this.send({ method: "initialized", params: {} });
    return result as { capabilities: Record<string, unknown> };
  }

  open(filePath: string, text: string): string {
    const uri = pathToFileURL(filePath).href;
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "toml", version: 1, text } },
    });
    return uri;
  }

  /** The messages of the document's diagnostics, as Monaco pulls them. */
  async diagnostics(uri: string): Promise<string[]> {
    const report = (await this.request("textDocument/diagnostic", { textDocument: { uri } })) as {
      items: { message: string }[];
    };
    return report.items.map((item) => item.message);
  }

  /** Wait until the server has asked the client to pull diagnostics again `count` times. */
  async refreshed(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (this.serverRequests.filter((m) => m === "workspace/diagnostic/refresh").length < count) {
      if (Date.now() > deadline) throw new Error("no workspace/diagnostic/refresh");
      await Bun.sleep(50);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
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
    const message = JSON.parse(data) as LspMessage;
    if (message.method !== undefined && message.id !== undefined) {
      this.serverRequests.push(message.method);
      this.send({ id: message.id, result: null });
      return;
    }
    if (message.id !== undefined) this.responses.get(message.id)?.(message.result);
  }
}

let wt: string | undefined;
let manager: TomlLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (wt) await rm(wt, { recursive: true, force: true });
  wt = undefined;
});

/** A worktree holding `schema.json` ({@link APP_SCHEMA}) and an `app.toml` it rejects. */
async function setup(): Promise<{ root: string; appToml: string; schemaUrl: string }> {
  wt = await realpath(await mkdtemp(join(tmpdir(), "toml-lsp-")));
  const schemaPath = join(wt, "schema.json");
  await writeFile(schemaPath, APP_SCHEMA);
  const appToml = join(wt, "app.toml");
  await writeFile(appToml, "name = 5\n");
  return { root: wt, appToml, schemaUrl: pathToFileURL(schemaPath).href };
}

describe.skipIf(!(await Bun.file(BUNDLED_TOMBI).exists()))("TomlLspManager with Tombi", () => {
  test(
    "applies the pushed schema mappings and follows their updates",
    async () => {
      const { root, appToml, schemaUrl } = await setup();
      manager = new TomlLspManager({ [schemaUrl]: ["app.toml"] });
      const client = new FakeClient(manager);
      const { capabilities } = await client.start(root);
      // Format on save owns formatting, and TextMate grammars own highlighting.
      expect(capabilities.documentFormattingProvider).toBeUndefined();
      expect(capabilities.semanticTokensProvider).toBeUndefined();
      expect(capabilities.completionProvider).toBeDefined();

      const uri = client.open(appToml, "name = 5\nextra = true\n");
      await client.refreshed(1);
      const mapped = await client.diagnostics(uri);
      expect(mapped).toHaveLength(2);
      expect(mapped.join("\n")).toContain("String");

      manager.updateSchemas({});
      await client.refreshed(2);
      expect(await client.diagnostics(uri)).toEqual([]);

      manager.updateSchemas({ [schemaUrl]: ["**/app.toml"] });
      await client.refreshed(3);
      expect(await client.diagnostics(uri)).toHaveLength(2);

      // Tombi asks for the workspace folders; the manager answers instead of the client.
      expect(client.serverRequests).not.toContain("workspace/workspaceFolders");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps a file's #:schema directive working without any mapping",
    async () => {
      const { root } = await setup();
      manager = new TomlLspManager({});
      const client = new FakeClient(manager);
      await client.start(root);
      const directive = join(root, "directive.toml");
      const uri = client.open(directive, "#:schema ./schema.json\nname = 5\n");
      await client.refreshed(1);
      expect((await client.diagnostics(uri)).join("\n")).toContain("String");
    },
    TEST_TIMEOUT_MS,
  );
});
