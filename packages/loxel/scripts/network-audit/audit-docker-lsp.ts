/**
 * Proves at the socket level that the bundled docker-language-server sends nothing off the machine
 * when it runs behind the real `loxel-server`. macOS only. Run it after changing the server's pin or
 * its manager; it exits non-zero on any outbound attempt or a missing language feature.
 *
 *   pnpm -C packages/loxel run build:server:standalone
 *   bun scripts/network-audit/audit-docker-lsp.ts [--binary <path>] [--inlay-hint] [--dwell <seconds>]
 *
 * `--binary` audits another build; Docker's release binary is the positive control and must fail,
 * as must `--inlay-hint`, which sends a request Loxel's client never sends to exercise the proxy
 * failsafe. Both fail by reaching the failsafe's dead port: the manager's environment keeps them
 * from leaving, and connect-log.c would block them if it did not. The dwell spans the periodic
 * flushes of the server's telemetry and session clients.
 *
 * The audit covers the server process. Its `docker buildx` child is the user's own Docker CLI, which
 * macOS does not let DYLD_INSERT_LIBRARIES reach, so it is out of scope here.
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
const FAILSAFE_TARGET = "127.0.0.1:9";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: path.join(BUILD, "docker-language-server") },
    dwell: { type: "string", default: "70" },
    "inlay-hint": { type: "boolean", default: false },
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
  readonly serverRequests: string[] = [];
  readonly diagnostics = new Map<string, unknown[]>();
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
        this.diagnostics.set(message.params.uri, message.params.diagnostics ?? []);
      } else if (message.method !== undefined && message.id !== undefined) {
        this.serverRequests.push(message.method);
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
const lspPath = path.join(work, "docker-language-server");
copyFileSync(path.join(BUILD, "loxel-server"), serverPath);
copyFileSync(values.binary, lspPath);
await $`codesign -s - -f ${serverPath} ${lspPath}`.quiet();

const repo = path.join(work, "repo");
await $`git init -q ${repo}`;
await $`git -C ${repo} remote add origin https://example.invalid/x.git`;
const dockerfileText = "FROM alpine:3.12\nRUN echo hi\n";
const bakeText =
  'target "app" {\n  dockerfile = "Dockerfile"\n  target = "nope"\n  tags = ["alpine:3.12"]\n}\n';
writeFileSync(path.join(repo, "Dockerfile"), dockerfileText);
writeFileSync(path.join(repo, "docker-bake.hcl"), bakeText);
const dockerfile = `file://${repo}/Dockerfile`;
const bake = `file://${repo}/docker-bake.hcl`;

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
    capabilities: { textDocument: { inlayHint: {}, hover: {}, completion: {} } },
  });
  const capabilities = (init.result as { capabilities: Record<string, unknown> }).capabilities;
  check(capabilities.inlayHintProvider === undefined, "inlay hints are not advertised");
  check(capabilities.hoverProvider !== undefined, "hover is advertised");
  check(capabilities.completionProvider !== undefined, "completion is advertised");

  client.notify({ method: "initialized", params: {} });
  for (const [uri, languageId, text] of [
    [dockerfile, "dockerfile", dockerfileText],
    [bake, "dockerbake", bakeText],
  ]) {
    client.notify({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId, version: 1, text } },
    });
  }
  // The server pulls each document's configuration before computing its diagnostics.
  const diagnosticsDeadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (!client.diagnostics.has(bake)) {
    if (Date.now() > diagnosticsDeadline) throw new Error("No diagnostics for the bake file");
    await Bun.sleep(50);
  }

  const scoutHover = await client.request("textDocument/hover", {
    textDocument: { uri: dockerfile },
    position: { line: 0, character: 7 },
  });
  check(
    scoutHover.result === null && !scoutHover.error,
    "a FROM image gets no Scout hover",
    scoutHover.result,
  );

  const bakeHover = await client.request("textDocument/hover", {
    textDocument: { uri: bake },
    position: { line: 1, character: 4 },
  });
  check(Boolean(bakeHover.result), "bake hover works", bakeHover.result);

  const completion = await client.request("textDocument/completion", {
    textDocument: { uri: bake },
    position: { line: 1, character: 2 },
  });
  const items = (completion.result as { items?: unknown[] } | null)?.items?.length ?? 0;
  check(items > 0, "bake completion works", `${items} items`);
  check(
    (client.diagnostics.get(bake)?.length ?? 0) > 0,
    "bake diagnostics work",
    client.diagnostics.get(bake),
  );

  client.notify({
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: dockerfile, version: 2 },
      contentChanges: [{ text: "FROM node:20\nRUN echo bye\n" }],
    },
  });

  if (values["inlay-hint"]) {
    await client.request("textDocument/inlayHint", {
      textDocument: { uri: dockerfile },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
    });
  }

  // Past the end of the bake file the server panics, which is where crash reports would be sent.
  await client.request("textDocument/hover", {
    textDocument: { uri: bake },
    position: { line: 99, character: 99 },
  });

  console.log(`     dwelling ${values.dwell}s for periodic flushes`);
  await Bun.sleep(Number(values.dwell) * 1000);
  check(
    !client.serverRequests.includes("workspace/configuration"),
    "the manager answers workspace/configuration itself",
  );

  // Closing drops a document's configuration, and the server publishes telemetry on shutdown.
  client.notify({ method: "textDocument/didClose", params: { textDocument: { uri: dockerfile } } });
  await client.request("shutdown", null);
} finally {
  server.kill();
  await server.exited;
}

// Only the language server's own lines: the Loxel server's traffic is another audit's.
const logged = readFileSync(logPath, { flag: "a+", encoding: "utf8" })
  .split("\n")
  .filter((line) => line !== "" && line.split(" ")[1] === "docker-language-server");
check(
  logged.some((line) => line.split(" ")[2] === "loaded"),
  "the logger loaded into docker-language-server",
);
const lines = logged.filter((line) => line.split(" ")[2] !== "loaded");
const outbound = lines.filter(
  (line) => line.endsWith(" BLOCKED") || line.includes(` ${FAILSAFE_TARGET} `),
);
console.log(`     ${lines.length} socket events from docker-language-server`);
for (const line of new Set(lines.map((entry) => entry.split(" ").slice(2).join(" ")))) {
  console.log(`     ${line}`);
}
check(outbound.length === 0, "no outbound connection attempts", outbound.length);

if (failures.length > 0) {
  console.error(`AUDIT FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("AUDIT PASSED");
