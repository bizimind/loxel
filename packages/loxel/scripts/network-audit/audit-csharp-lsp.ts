/**
 * Proves at the socket level that the user's csharp-ls sends nothing off the machine when it runs
 * behind the real server with a real file open, through every feature Loxel uses, its children
 * included. macOS only. Run it after changing the manager or the versions it accepts; it exits
 * non-zero on any outbound attempt or a missing language feature.
 *
 *   bun scripts/network-audit/audit-csharp-lsp.ts --repo <restored copy> --file <relative .cs> \
 *     --dotnet-root <dir> --csharp-ls <dir> [--nuget-packages <dir>] [--dwell <seconds>] [--trust no]
 *
 * `--repo` is used in place, and is trusted in the audit's own state. `--dotnet-root` must be a copy
 * of a .NET install signed ad hoc (`codesign -s - -f` on `dotnet`, `hostfxr`, `hostpolicy`, the
 * runtime's and SDK's dylibs), since macOS drops DYLD_INSERT_LIBRARIES for the hardened originals.
 * `--csharp-ls` is the directory holding the `csharp-ls` launcher. `--control` restores a project
 * whose `nuget.config` names an unreachable feed instead, and must log the attempt: a clean audit
 * proves nothing unless the same setup catches .NET's sockets.
 */

import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

const REQUEST_TIMEOUT_MS = 180_000;
const LOAD_TIMEOUT_MS = 600_000;
/** Actions this many are resolved, each of which runs real code. */
const MAX_RESOLVED_ACTIONS = 60;
const CONTROL_HOST = "feed.invalid";
/** TEST-NET-2: reserved, and never routed. */
const CONTROL_IP = "198.51.100.1";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    file: { type: "string" },
    "dotnet-root": { type: "string" },
    "csharp-ls": { type: "string" },
    "nuget-packages": { type: "string" },
    dwell: { type: "string", default: "60" },
    trust: { type: "string", default: "yes" },
    control: { type: "boolean", default: false },
  },
});

const dotnetRoot = values["dotnet-root"];
const csharpLsDir = values["csharp-ls"];
if (!dotnetRoot || !csharpLsDir) throw new Error("--dotnet-root and --csharp-ls are required");

const work = mkdtempSync(path.join(tmpdir(), "csharp-lsp-audit-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const logPath = path.join(work, "connections.log");
const dylib = path.join(work, "connect-log.dylib");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

const auditEnv = {
  CONNECT_LOG: logPath,
  DYLD_INSERT_LIBRARIES: dylib,
  DOTNET_ROOT: dotnetRoot,
  PATH: `${dotnetRoot}:${csharpLsDir}:/usr/bin:/bin`,
  HOME: process.env.HOME ?? work,
  // No telemetry opt-out here: the manager has to set it, for csharp-ls and the `dotnet` it starts.
  ...(values["nuget-packages"] ? { NUGET_PACKAGES: values["nuget-packages"] } : {}),
};

function logged(): string[] {
  return readFileSync(logPath, { flag: "a+", encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

function outbound(lines: string[]): string[] {
  return lines.filter((line) => line.endsWith(" BLOCKED"));
}

const failures: string[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  const shown = detail === undefined ? "" : `: ${JSON.stringify(detail)}`;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${shown}`);
  if (!ok) failures.push(label);
}

function finish(): never {
  if (failures.length > 0) {
    console.error(`AUDIT FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("AUDIT PASSED");
  process.exit(0);
}

if (values.control) {
  const project = path.join(work, "control");
  await $`mkdir -p ${project}`;
  writeFileSync(
    path.join(project, "Control.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="No.Such.Package" Version="1.0.0" /></ItemGroup></Project>`,
  );
  writeFileSync(
    path.join(project, "nuget.config"),
    `<configuration><packageSources><clear /><add key="y" value="https://${CONTROL_IP}/v3/index.json" /><add key="x" value="https://${CONTROL_HOST}/v3/index.json" /></packageSources></configuration>`,
  );
  await Bun.spawn([path.join(dotnetRoot, "dotnet"), "restore", "--disable-parallel"], {
    cwd: project,
    env: {
      ...auditEnv,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      NUGET_PACKAGES: path.join(work, "nuget"),
    },
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  const lines = logged();
  check(
    lines.some((line) => line.includes(CONTROL_HOST)),
    "the logger caught .NET looking up a feed",
  );
  check(
    lines.some((line) => line.includes(CONTROL_IP)),
    "the logger caught .NET connecting to a feed",
  );
  finish();
}

if (!values.repo || !values.file) throw new Error("--repo and --file are required");
const repo = path.resolve(values.repo);
const filePath = path.join(repo, values.file);
const fileUri = `file://${filePath}`;
const text = readFileSync(filePath, "utf8");

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** The Monaco client's side of the connection, over the server's real WebSocket route. */
class LspClient {
  readonly messages: { type: number; message: string }[] = [];
  readonly registrations: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
  }

  private onMessage(data: string): void {
    const message = JSON.parse(data) as RpcMessage;
    if (message.method === "window/showMessage") {
      this.messages.push(message.params as { type: number; message: string });
    } else if (message.method !== undefined && message.id !== undefined) {
      if (message.method === "client/registerCapability") {
        const { registrations } = message.params as { registrations: { method: string }[] };
        this.registrations.push(...registrations.map((entry) => entry.method));
      }
      this.notify({ id: message.id, result: null });
    } else if (message.id !== undefined) {
      const resolve = this.pending.get(message.id);
      if (typeof resolve === "function") resolve(message);
    }
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
        this.pending.delete(id);
        resolve(message);
      });
      this.notify({ id, method, params });
    });
  }
}

/** What Monaco's client declares for these features, so the server registers them dynamically. */
const featureCapabilities = {
  textDocument: Object.fromEntries(
    [
      "hover",
      "definition",
      "references",
      "rename",
      "signatureHelp",
      "documentSymbol",
      "formatting",
      "rangeFormatting",
      "inlayHint",
      "diagnostic",
      "completion",
      "codeAction",
      "semanticTokens",
    ].map((feature) => [feature, { dynamicRegistration: true }]),
  ),
  workspace: { symbol: { dynamicRegistration: true }, configuration: true },
};

const serverPath = path.join(work, "bun");
copyFileSync(process.execPath, serverPath);
await $`chmod +x ${serverPath} && codesign -s - -f ${serverPath}`.quiet();
const dekFile = path.join(work, "dek");
writeFileSync(dekFile, randomBytes(32).toString("base64"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([serverPath, "src/server/index.ts", repo], {
  cwd: path.resolve(import.meta.dir, "../.."),
  stdout: "ignore",
  stderr: Bun.file(path.join(work, "server.log")),
  env: {
    ...auditEnv,
    LOXEL_DEK_FILE: dekFile,
    LOXEL_DEV: "1",
    LOXEL_SERVE_PORT: String(port),
    LOXEL_STATE_DIR: path.join(work, "state"),
  },
});

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (
      await fetch(`${base}/api/projects`).then(
        (res) => res.ok,
        () => false,
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("Server did not start");
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)));
  });
}

function positionOf(offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

function count(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const { items, data, changes, documentChanges } = result as Record<string, unknown[]>;
    return (items ?? data ?? documentChanges ?? Object.keys(changes ?? {}) ?? []).length;
  }
  return result ? 1 : 0;
}

try {
  await waitForServer();
  await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repo }),
  });
  if (values.trust === "yes") {
    const trust = await fetch(`${base}/api/repo-trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: repo, decision: "trusted" }),
    });
    check(trust.ok, "the repository is trusted", trust.status);
  }

  const started = Date.now();
  const url = `ws://127.0.0.1:${port}/ws/csharp-lsp?wt=${encodeURIComponent(repo)}`;
  const client = new LspClient(await connect(url));
  await client.request("initialize", {
    processId: null,
    clientInfo: { name: "network-audit", version: "0" },
    capabilities: featureCapabilities,
  });
  client.notify({ method: "initialized", params: {} });
  client.notify({
    method: "textDocument/didOpen",
    params: { textDocument: { uri: fileUri, languageId: "csharp", version: 1, text } },
  });
  const td = { textDocument: { uri: fileUri } };

  if (values.trust !== "yes") {
    await Bun.sleep(Number(values.dwell) * 1000);
    check(
      !logged().some((line) => !line.split(" ")[1]?.startsWith("bun")),
      "nothing but the server loaded the logger",
      logged().slice(0, 5),
    );
    client.notify({ method: "exit" });
  } else {
    // The project loads in the background; until then there is nothing to name.
    let symbols: {
      name: string;
      location?: { range: { start: unknown } };
      selectionRange?: { start: unknown };
      children?: unknown[];
    }[] = [];
    let hovered: unknown = null;
    let position: { line: number; character: number } = positionOf(0);
    while (Date.now() - started < LOAD_TIMEOUT_MS) {
      if (client.registrations.includes("textDocument/documentSymbol")) {
        const reply = await client.request("textDocument/documentSymbol", td);
        symbols = (reply.result as typeof symbols | null) ?? [];
        const name = symbols.at(-1)?.name;
        const offset = name ? text.lastIndexOf(name) : -1;
        if (offset >= 0) {
          position = positionOf(offset);
          hovered = (await client.request("textDocument/hover", { ...td, position })).result;
          if (hovered) break;
        }
      }
      await Bun.sleep(1000);
    }
    check(Boolean(hovered), "hover works", `after ${Math.round((Date.now() - started) / 1000)} s`);
    // A file's own symbols answer before the projects are in: the rest waits for the whole load.
    const query = { query: /\w+/.exec(symbols.at(-1)?.name ?? "")?.[0] ?? "" };
    while (Date.now() - started < LOAD_TIMEOUT_MS) {
      if (count((await client.request("workspace/symbol", query)).result) > 0) break;
      await Bun.sleep(2000);
    }
    console.log(`     project loaded after ${Math.round((Date.now() - started) / 1000)} s`);
    console.log(`     registered: ${[...new Set(client.registrations)].join(", ")}`);

    const memberAccess = /\w\.\w/.exec(text.slice(text.lastIndexOf("{", text.indexOf("(") + 1)));
    const memberPosition = positionOf(
      text.lastIndexOf("{", text.indexOf("(") + 1) + (memberAccess?.index ?? 0) + 2,
    );
    for (const [label, method, params] of [
      ["definition", "textDocument/definition", { ...td, position }],
      [
        "references",
        "textDocument/references",
        { ...td, position, context: { includeDeclaration: true } },
      ],
      [
        "completion",
        "textDocument/completion",
        { ...td, position: memberPosition, context: { triggerKind: 2, triggerCharacter: "." } },
      ],
      ["signature help", "textDocument/signatureHelp", { ...td, position }],
      ["rename", "textDocument/rename", { ...td, position, newName: "Renamed" }],
      ["workspace symbols", "workspace/symbol", query],
      [
        "formatting",
        "textDocument/formatting",
        { ...td, options: { tabSize: 4, insertSpaces: true } },
      ],
      ["diagnostics", "textDocument/diagnostic", td],
      ["semantic tokens", "textDocument/semanticTokens/full", td],
      [
        "inlay hints",
        "textDocument/inlayHint",
        { ...td, range: { start: positionOf(0), end: positionOf(text.length) } },
      ],
    ] as const) {
      const reply = await client.request(method, params);
      console.log(
        `     ${label}: ${count(reply.result)}${reply.error ? ` ${JSON.stringify(reply.error)}` : ""}`,
      );
      if (label !== "signature help" && label !== "formatting") {
        check(!reply.error, `${label} answers`);
      }
    }

    // Unknown names are what would offer to fetch a package, if anything does.
    const probe = `\nclass LoxelAuditProbe { void M() { var a = new JsonConvert(); var b = new Regex("a"); } }\n`;
    client.notify({
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: fileUri, version: 2 },
        contentChanges: [
          { range: { start: positionOf(text.length), end: positionOf(text.length) }, text: probe },
        ],
      },
    });
    const end = positionOf(text.length);
    const probeLine = end.line + 1;
    for (const needle of ["JsonConvert", "Regex"]) {
      const character = probe.trimStart().indexOf(needle);
      const start = { line: probeLine, character };
      const actions = await client.request("textDocument/codeAction", {
        ...td,
        range: { start, end: { line: probeLine, character: character + needle.length } },
        context: { diagnostics: [] },
      });
      const list = (actions.result as { title: string }[] | null) ?? [];
      console.log(
        `     code actions on ${needle}: ${list.map((action) => action.title).join(" | ")}`,
      );
      for (const action of list.slice(0, MAX_RESOLVED_ACTIONS)) {
        await client.request("codeAction/resolve", action);
      }
    }
    console.log(`     messages: ${JSON.stringify(client.messages)}`);

    console.log(`     dwelling ${values.dwell}s`);
    await Bun.sleep(Number(values.dwell) * 1000);
    await client.request("shutdown", null);
  }
} finally {
  server.kill();
  await server.exited;
}

const lines = logged();
const programs = [
  ...new Set(
    lines.filter((line) => line.split(" ")[2] === "loaded").map((line) => line.split(" ")[1]),
  ),
];
console.log(`     processes with the logger: ${programs.join(", ")}`);
if (values.trust === "yes") {
  check(programs.includes("csharp-ls"), "the logger loaded into csharp-ls");
}
// The Loxel server's own traffic is another audit's: only what ran below it counts.
const notServer = lines.filter((line) => line.split(" ")[1] !== "bun");
const attempts = outbound(notServer);
for (const line of new Set(attempts.map((entry) => entry.split(" ").slice(1).join(" ")))) {
  console.log(`     ${line}`);
}
check(attempts.length === 0, "no outbound attempts", attempts.length);
finish();
