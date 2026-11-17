/**
 * Proves at the socket level that the bundled Dockerfile language server (dockerfile-language-
 * server-nodejs, built as `docker-langserver`) sends nothing off the machine when it runs behind the
 * real `loxel-server`. macOS only. Run it after upgrading the server or changing its build or
 * manager; it exits non-zero on any outbound attempt or a missing language feature.
 *
 *   pnpm -C packages/loxel run build:server:standalone
 *   bun scripts/network-audit/audit-docker-lsp.ts [--binary <path>]
 *
 * `--binary` audits another build. The positive control is the package compiled without the build's
 * offline registry client, which must fail by asking Docker Hub for the image's tags when completing
 * one after `FROM alpine:` (connect-log.c blocks the lookup):
 *
 *   bun build node_modules/dockerfile-language-server-nodejs/lib/server.js --compile --outfile <path>
 */

import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

const LOXEL = path.resolve(import.meta.dir, "../..");
const BUILD = path.join(LOXEL, "build");
const REQUEST_TIMEOUT_MS = 15_000;
const BINARY = "docker-langserver";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: path.join(BUILD, BINARY) },
    dwell: { type: "string", default: "5" },
  },
});

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { uri?: string; diagnostics?: unknown[] };
  result?: unknown;
  error?: unknown;
}

/** The Monaco client's side of the connection, over the server's real WebSocket route. */
class LspClient {
  readonly diagnostics = new Map<string, unknown[]>();
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
        this.diagnostics.set(message.params.uri, message.params.diagnostics ?? []);
      } else if (message.method !== undefined && message.id !== undefined) {
        this.notify({ id: message.id, result: null });
      } else if (message.id !== undefined) {
        const resolve = this.pending.get(message.id);
        if (typeof resolve === "function") resolve(message);
      }
    });
  }

  notify(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No reply to ${method}`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.notify({ id, method, params });
    });
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)));
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const up = await fetch(url).then(
      () => true,
      () => false,
    );
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error("loxel-server did not start");
}

const work = mkdtempSync(path.join(tmpdir(), "docker-lsp-audit-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const dylib = path.join(work, "connect-log.dylib");
const logPath = path.join(work, "connections.log");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

// The server finds language servers next to itself, so a copy of it audits any binary. An ad-hoc
// signature drops the hardened runtime of a signed binary, which would ignore the logger.
const serverPath = path.join(work, "loxel-server");
const lspPath = path.join(work, BINARY);
copyFileSync(path.join(BUILD, "loxel-server"), serverPath);
copyFileSync(values.binary, lspPath);
await $`codesign -s - -f ${serverPath} ${lspPath}`.quiet();

const repo = path.join(work, "repo");
await $`git init -q ${repo}`;
await $`git -C ${repo} remote add origin https://example.invalid/x.git`;
// Two CMDs and a MAINTAINER draw dockerfile-utils warnings; the link and tag positions are the
// features that name Docker Hub.
const dockerfileText = 'FROM alpine:3\nMAINTAINER me\nRUN echo hi\nCMD ["a"]\nCMD ["b"]\n';
writeFileSync(path.join(repo, "Dockerfile"), dockerfileText);
const dockerfile = `file://${repo}/Dockerfile`;

// The server's secret store needs a key; this one only ever opens the audit's own empty state.
const dekFile = path.join(work, "dek");
writeFileSync(dekFile, randomBytes(32).toString("base64"));

const port = 20_000 + Math.floor(Math.random() * 20_000);
const server = Bun.spawn([serverPath], {
  stdout: "ignore",
  stderr: "ignore",
  env: {
    ...process.env,
    CONNECT_LOG: logPath,
    DYLD_INSERT_LIBRARIES: dylib,
    LOXEL_DEK_FILE: dekFile,
    LOXEL_SERVE_PORT: String(port),
    LOXEL_STATE_DIR: path.join(work, "state"),
  },
});

const failures: string[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(label);
}

try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  const wsUrl = `ws://127.0.0.1:${port}/ws/docker-lsp?wt=${encodeURIComponent(repo)}`;
  const client = new LspClient(await connect(wsUrl));

  const init = await client.request("initialize", {
    processId: null,
    rootUri: `file://${repo}`,
    clientInfo: { name: "network-audit", version: "0" },
    capabilities: {
      workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } },
      textDocument: {
        hover: { contentFormat: ["markdown"] },
        completion: { completionItem: { snippetSupport: true } },
      },
    },
  });
  const capabilities = (init.result as { capabilities: Record<string, unknown> }).capabilities;
  check(capabilities.hoverProvider !== undefined, "hover is advertised");
  check(capabilities.completionProvider !== undefined, "completion is advertised");

  client.notify({ method: "initialized", params: {} });
  client.notify({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: dockerfile, languageId: "dockerfile", version: 1, text: dockerfileText },
    },
  });
  const diagnosticsDeadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (!client.diagnostics.has(dockerfile)) {
    if (Date.now() > diagnosticsDeadline) throw new Error("No diagnostics for the Dockerfile");
    await Bun.sleep(50);
  }
  check(
    (client.diagnostics.get(dockerfile)?.length ?? 0) > 0,
    "Dockerfile diagnostics work",
    client.diagnostics.get(dockerfile)?.length,
  );

  const hover = await client.request("textDocument/hover", {
    textDocument: { uri: dockerfile },
    position: { line: 2, character: 1 },
  });
  check(Boolean(hover.result), "hover works");

  const keywords = await client.request("textDocument/completion", {
    textDocument: { uri: dockerfile },
    position: { line: 5, character: 0 },
  });
  const items = Array.isArray(keywords.result) ? keywords.result.length : 0;
  check(items > 0, "completion works", `${items} items`);

  // The request that asks Docker Hub for alpine's tags, unless the build replaced its client.
  const tags = await client.request("textDocument/completion", {
    textDocument: { uri: dockerfile },
    position: { line: 0, character: 13 },
  });
  check(!tags.error, "image tag completion answers", tags.error);

  const links = await client.request("textDocument/documentLink", {
    textDocument: { uri: dockerfile },
  });
  const [link] = Array.isArray(links.result) ? links.result : [];
  check(link !== undefined, "the FROM image gets a link");
  if (link !== undefined) {
    const resolved = await client.request("documentLink/resolve", link);
    check(!resolved.error, "resolving the link answers", resolved.error);
  }

  const formatting = await client.request("textDocument/formatting", {
    textDocument: { uri: dockerfile },
    options: { tabSize: 4, insertSpaces: true },
  });
  check(!formatting.error, "formatting answers", formatting.error);

  console.log(`     dwelling ${values.dwell}s`);
  await Bun.sleep(Number(values.dwell) * 1000);
  client.notify({ method: "textDocument/didClose", params: { textDocument: { uri: dockerfile } } });
  await client.request("shutdown", null);
} finally {
  server.kill();
  await server.exited;
}

// Only the language server's own lines: the Loxel server's traffic is another audit's.
const logged = readFileSync(logPath, { flag: "a+", encoding: "utf8" })
  .split("\n")
  .filter((line) => line !== "" && line.split(" ")[1] === BINARY);
check(
  logged.some((line) => line.split(" ")[2] === "loaded"),
  `the logger loaded into ${BINARY}`,
);
const lines = logged.filter((line) => line.split(" ")[2] !== "loaded");
const outbound = lines.filter((line) => line.endsWith(" BLOCKED"));
console.log(`     ${lines.length} socket events from ${BINARY}`);
for (const line of new Set(lines.map((entry) => entry.split(" ").slice(2).join(" ")))) {
  console.log(`     ${line}`);
}
check(outbound.length === 0, "no outbound connection attempts", outbound.length);

if (failures.length > 0) {
  console.error(`AUDIT FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("AUDIT PASSED");
