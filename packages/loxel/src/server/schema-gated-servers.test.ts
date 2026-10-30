import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { lemminxCachePath } from "./schema-downloads";
import type { StdioLspManager } from "./stdio-lsp-manager";
import { withoutForceDownload, XmlLspManager } from "./xml-lsp-manager";
import { YamlLspManager } from "./yaml-lsp-manager";

const TEST_TIMEOUT_MS = 30_000;
const BUILD = resolve(import.meta.dir, "../../build");
const SCHEMA = JSON.stringify({ type: "object", required: ["name"] });

interface LspMessage {
  id?: number | string;
  method?: string;
  params?: { uri?: string; diagnostics?: { message: string }[] };
}

/** Speaks LSP to a manager the way a window does, and hears what the server tells it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  private readonly initialized: Promise<void>;
  private markInitialized = () => {};
  private readonly diagnosticWaiters = new Set<(messages: string[]) => void>();

  constructor(private readonly manager: StdioLspManager<never, unknown>) {
    const ws = {
      send: (data: string) => {
        this.receive(JSON.parse(data) as LspMessage);
        return data.length;
      },
      close: () => {},
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
    this.initialized = new Promise((done) => {
      this.markInitialized = done;
    });
  }

  async start(): Promise<void> {
    this.send({ id: 1, method: "initialize", params: { processId: null, capabilities: {} } });
    await this.initialized;
    this.send({ method: "initialized", params: {} });
  }

  open(uri: string, languageId: string, text: string): void {
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId, version: 1, text } },
    });
  }

  /** Resolves with the next diagnostics the server publishes that satisfy `accept`. */
  diagnostics(accept: (messages: string[]) => boolean): Promise<string[]> {
    return new Promise((done) => {
      const waiter = (messages: string[]) => {
        if (!accept(messages)) return;
        this.diagnosticWaiters.delete(waiter);
        done(messages);
      };
      this.diagnosticWaiters.add(waiter);
    });
  }

  private send(message: Record<string, unknown>): void {
    this.manager.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(message: LspMessage): void {
    if (message.id === 1 && message.method === undefined) this.markInitialized();
    if (message.method !== undefined && message.id !== undefined) {
      this.send({ id: message.id, result: null });
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const messages = (message.params?.diagnostics ?? []).map((d) => d.message);
      for (const waiter of [...this.diagnosticWaiters]) waiter(messages);
    }
  }
}

let cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup) await step();
  cleanup = [];
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schema-gated-")));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A local server that records what is asked of it: nothing may reach it. */
function recordingServer(): { url: (path: string) => string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      hits.push(new URL(req.url).pathname);
      return new Response(SCHEMA);
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: (path) => `http://127.0.0.1:${server.port}${path}`, hits };
}

describe.skipIf(!(await Bun.file(join(BUILD, "yaml-language-server")).exists()))(
  "YamlLspManager with yaml-language-server",
  () => {
    let manager: YamlLspManager | undefined;

    function start(schemaContent: (url: string) => Promise<string>) {
      const yaml = new YamlLspManager({}, schemaContent);
      manager = yaml;
      cleanup.push(() => yaml.destroy());
      const client = new FakeClient(yaml as unknown as StdioLspManager<never, unknown>);
      yaml.attach(client.ws);
      return client;
    }

    test(
      "asks Loxel for a modeline's schema instead of fetching it",
      async () => {
        const dir = await tempDir();
        const remote = recordingServer();
        const schemaUrl = remote.url("/modeline.json");
        const asked: string[] = [];
        const client = start(async (url) => {
          asked.push(url);
          return SCHEMA;
        });
        await client.start();
        const uri = pathToFileURL(join(dir, "a.yaml")).href;
        const reported = client.diagnostics((messages) => messages.length > 0);
        client.open(uri, "yaml", `# yaml-language-server: $schema=${schemaUrl}\nother: 1\n`);

        // The schema reached the server through Loxel: it reports what is missing.
        expect((await reported).join("\n")).toContain("name");
        expect(asked).toEqual([schemaUrl]);
        expect(remote.hits).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "applies the schema mappings from Settings > Schemas",
      async () => {
        const dir = await tempDir();
        const schemaPath = join(dir, "mapped.json");
        await Bun.write(schemaPath, SCHEMA);
        const client = start(async () => "{}");
        manager?.updateSchemas({ [pathToFileURL(schemaPath).href]: ["**/mapped.yaml"] });
        await client.start();
        const uri = pathToFileURL(join(dir, "mapped.yaml")).href;
        const reported = client.diagnostics((messages) => messages.length > 0);
        client.open(uri, "yaml", "other: 1\n");
        expect((await reported).join("\n")).toContain("name");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "accepts the file when Loxel withholds the schema",
      async () => {
        const dir = await tempDir();
        const asked: string[] = [];
        const client = start(async (url) => {
          asked.push(url);
          return "{}";
        });
        await client.start();
        const uri = pathToFileURL(join(dir, "a.yaml")).href;
        const reported = client.diagnostics(() => asked.length > 0);
        client.open(
          uri,
          "yaml",
          "# yaml-language-server: $schema=https://schemas.loxel.invalid/a.json\nother: 1\n",
        );
        expect(await reported).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe("withoutForceDownload", () => {
  const frame = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 7, result });

  test("removes LemMinX's force download quick fixes and keeps the rest", () => {
    const body = frame([{ title: "Force download of 'http://x/a.xsd'." }, { title: "Close tag" }]);
    expect(JSON.parse(withoutForceDownload(body)).result).toEqual([{ title: "Close tag" }]);
  });

  test("leaves other frames as they are", () => {
    const notification = `{"method":"window/logMessage","params":{"message":"Force download"}}`;
    expect(withoutForceDownload(notification)).toBe(notification);
    const other = frame([{ title: "Close tag" }]);
    expect(withoutForceDownload(other)).toBe(other);
  });
});

describe.skipIf(!(await Bun.file(join(BUILD, "lemminx/lemminx")).exists()))(
  "XmlLspManager with LemMinX",
  () => {
    const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root"><xs:complexType>
    <xs:attribute name="required" type="xs:string" use="required"/>
  </xs:complexType></xs:element>
</xs:schema>`;

    async function start(workDir: string, wtPath: string) {
      const manager = new XmlLspManager(workDir);
      cleanup.push(() => manager.destroy());
      const client = new FakeClient(manager as unknown as StdioLspManager<never, unknown>);
      manager.createSession(client.ws, wtPath);
      await client.start();
      return client;
    }

    const document = (schemaUrl: string) => `<?xml version="1.0"?>
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${schemaUrl}"/>
`;

    test(
      "does not download a schema a file names",
      async () => {
        const dir = await tempDir();
        const remote = recordingServer();
        const client = await start(join(dir, "work"), dir);
        const reported = client.diagnostics((messages) =>
          messages.some((m) => m.includes("disabled")),
        );
        client.open(
          pathToFileURL(join(dir, "a.xml")).href,
          "xml",
          document(remote.url("/named.xsd")),
        );
        await reported;
        expect(remote.hits).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "reaches nothing for a URL its cache does not handle",
      async () => {
        const dir = await tempDir();
        const remote = recordingServer();
        const client = await start(join(dir, "work"), dir);
        const reported = client.diagnostics((messages) =>
          messages.some((m) => m.includes("up.xsd")),
        );
        const location = remote.url("/up.xsd").replace("http:", "hTtP:");
        client.open(pathToFileURL(join(dir, "a.xml")).href, "xml", document(location));
        await reported;
        expect(remote.hits).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "validates against a schema in its cache",
      async () => {
        const dir = await tempDir();
        const remote = recordingServer();
        const workDir = join(dir, "work");
        const schemaUrl = remote.url("/cached.xsd");
        await Bun.write(lemminxCachePath(workDir, schemaUrl)!, XSD);
        const client = await start(workDir, dir);
        const reported = client.diagnostics((messages) => messages.length > 0);
        client.open(pathToFileURL(join(dir, "a.xml")).href, "xml", document(schemaUrl));
        expect((await reported).join("\n")).toContain("required");
        expect(remote.hits).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
