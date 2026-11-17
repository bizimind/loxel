/**
 * Proves at the socket level that the bundled terraform-ls sends nothing off the machine. macOS
 * only. Run it after changing the server's pin or its manager; it exits non-zero on any outbound
 * attempt or a missing language feature.
 *
 *   pnpm -C packages/loxel run build:server:standalone
 *   bun scripts/network-audit/audit-terraform-ls.ts [--binary <path>] [--dwell <seconds>]
 *
 * Two runs, each completing a module `source`, which is where a release build searches the
 * Terraform Registry:
 *
 * - Behind the real `loxel-server`, in an untrusted repository whose file calls a registry module:
 *   terraform-ls fetches that module's inputs and outputs, and the manager's proxy, which leads
 *   nowhere, must be the only place any request goes.
 * - The server alone, with no proxy at all: a build without Algolia credentials has no search to
 *   make, so nothing may leave even with nothing to stop it.
 *
 * `--binary` audits another build. HashiCorp's release binary, which embeds the credentials, is
 * the positive control and must fail the second run by reaching for Algolia.
 */

import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { $ } from "bun";

const LOXEL = path.resolve(import.meta.dir, "../..");
const BUILD = path.join(LOXEL, "build");
const PROGRAM = "terraform-ls";
const REQUEST_TIMEOUT_MS = 15_000;
const FAILSAFE_TARGET = "127.0.0.1:9";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: path.join(BUILD, PROGRAM) },
    dwell: { type: "string", default: "10" },
  },
});

/** A module `source` to complete, where a release build searches the registry. */
const SEARCH_TF = 'module "search" {\n  source = "consul"\n}\n';
const SOURCE_POSITION = { line: 1, character: 18 };
/** Adds a registry module, whose inputs and outputs terraform-ls fetches. */
const REGISTRY_TF = `${SEARCH_TF}
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}
`;

interface RpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
}

/** The client's side of an LSP connection, over whatever carries its frames. */
class LspClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(private readonly write: (frame: string) => void) {}

  receive(message: RpcMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      this.notify({ id: message.id, result: null });
    } else if (message.id !== undefined) {
      this.pending.get(message.id)?.(message);
    }
  }

  notify(message: Record<string, unknown>): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", ...message }));
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

const failures: string[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(label);
}

/** Opens `repo`'s `main.tf`, holding `text`, completes its module `source`, hovers and dwells. */
async function exercise(client: LspClient, repo: string, text: string): Promise<void> {
  const init = await client.request("initialize", {
    processId: null,
    rootUri: pathToFileURL(repo).href,
    workspaceFolders: [{ uri: pathToFileURL(repo).href, name: "repo" }],
    capabilities: {
      workspace: { workspaceFolders: true },
      textDocument: { completion: {}, hover: {}, publishDiagnostics: {} },
    },
  });
  check(Boolean(init.result), "initialize succeeds", init.error);
  client.notify({ method: "initialized", params: {} });
  const uri = pathToFileURL(path.join(repo, "main.tf")).href;
  client.notify({
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "terraform", version: 1, text } },
  });

  const completion = await client.request("textDocument/completion", {
    textDocument: { uri },
    position: SOURCE_POSITION,
  });
  // An answer, not an error: the completion ran terraform-ls's module source hooks.
  check(
    completion.result !== null && completion.result !== undefined && !completion.error,
    "module source completion answers",
    completion.error,
  );
  const hover = await client.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 1, character: 3 },
  });
  check(Boolean(hover.result), "hover works", hover.error);

  console.log(`     dwelling ${values.dwell}s for background registry fetches`);
  await Bun.sleep(Number(values.dwell) * 1000);
  await client.request("shutdown", null);
}

/** The audited program's socket events in `logPath`, after checking the logger was in it. */
function socketEvents(logPath: string, run: string): string[] {
  const logged = readFileSync(logPath, { flag: "a+", encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "" && line.split(" ")[1] === PROGRAM);
  check(
    logged.some((line) => line.split(" ")[2] === "loaded"),
    `${run}: the logger loaded into terraform-ls`,
  );
  const events = logged.filter((line) => line.split(" ")[2] !== "loaded");
  console.log(`     ${events.length} socket events from terraform-ls`);
  for (const event of new Set(events.map((line) => line.split(" ").slice(2).join(" ")))) {
    console.log(`     ${event}`);
  }
  return events;
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

/** A fresh git repository whose `main.tf` holds `text`. */
async function makeRepo(dir: string, text: string): Promise<string> {
  await $`git init -q ${dir}`;
  writeFileSync(path.join(dir, "main.tf"), text);
  return dir;
}

/** terraform-ls behind `loxel-server`, as Loxel runs it, in a repository that isn't trusted. */
async function auditBehindLoxel(work: string, dylib: string): Promise<void> {
  console.log("Behind loxel-server, with the manager's environment:");
  const logPath = path.join(work, "loxel.log");
  // The server finds language servers next to itself, so a copy of it audits any binary. An ad-hoc
  // signature drops the hardened runtime of a signed binary, which would ignore the logger.
  const dir = path.join(work, "loxel");
  mkdirSync(dir);
  const serverPath = path.join(dir, "loxel-server");
  const lspPath = path.join(dir, PROGRAM);
  copyFileSync(path.join(BUILD, "loxel-server"), serverPath);
  copyFileSync(values.binary, lspPath);
  await $`codesign -s - -f ${serverPath} ${lspPath}`.quiet();
  const repo = await makeRepo(path.join(work, "loxel-repo"), REGISTRY_TF);

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
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    const ws = await connect(
      `ws://127.0.0.1:${port}/ws/terraform-lsp?wt=${encodeURIComponent(repo)}`,
    );
    const client = new LspClient((frame) => ws.send(frame));
    ws.addEventListener("message", (event) => {
      client.receive(JSON.parse(String(event.data)) as RpcMessage);
    });
    await exercise(client, repo, REGISTRY_TF);
  } finally {
    server.kill();
    await server.exited;
  }

  const events = socketEvents(logPath, "behind loxel-server");
  const blocked = events.filter((line) => line.endsWith(" BLOCKED"));
  check(blocked.length === 0, "nothing goes around the manager's proxy", blocked.length);
  check(
    events.some((line) => line.includes(` ${FAILSAFE_TARGET} `)),
    "the registry fetch reached the dead-end proxy, which stopped it",
  );
}

/** terraform-ls on its own over stdio, with no proxy to stop anything. */
async function auditWithoutProxy(work: string, dylib: string): Promise<void> {
  console.log("Alone, with no proxy:");
  const logPath = path.join(work, "alone.log");
  const dir = path.join(work, "alone");
  mkdirSync(dir);
  const lspPath = path.join(dir, PROGRAM);
  copyFileSync(values.binary, lspPath);
  await $`codesign -s - -f ${lspPath}`.quiet();
  // No registry module whose data would be fetched: only the search could reach out.
  const repo = await makeRepo(path.join(work, "alone-repo"), SEARCH_TF);

  const proc = Bun.spawn([lspPath, "serve"], {
    cwd: repo,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: work, CONNECT_LOG: logPath, DYLD_INSERT_LIBRARIES: dylib },
  });
  const client = new LspClient((frame) => {
    void proc.stdin.write(`Content-Length: ${Buffer.byteLength(frame)}\r\n\r\n${frame}`);
    void proc.stdin.flush();
  });
  void (async () => {
    let buffer = Buffer.alloc(0);
    for await (const chunk of proc.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString();
        const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(length))
          throw new Error(`No Content-Length in ${JSON.stringify(header)}`);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) break;
        client.receive(
          JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString()) as RpcMessage,
        );
        buffer = buffer.subarray(bodyStart + length);
      }
    }
  })().catch((error: unknown) => check(false, "terraform-ls speaks LSP on stdout", String(error)));
  try {
    await exercise(client, repo, SEARCH_TF);
  } finally {
    proc.kill();
    await proc.exited;
  }

  const events = socketEvents(logPath, "alone");
  const outbound = events.filter((line) => line.endsWith(" BLOCKED"));
  check(outbound.length === 0, "completing a module source reaches for nothing", outbound.length);
}

const work = mkdtempSync(path.join(tmpdir(), "terraform-ls-audit-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const dylib = path.join(work, "connect-log.dylib");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

await auditBehindLoxel(work, dylib);
await auditWithoutProxy(work, dylib);

if (failures.length > 0) {
  console.error(`AUDIT FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("AUDIT PASSED");
