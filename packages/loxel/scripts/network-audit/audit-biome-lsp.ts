/**
 * Proves at the socket level that a project's Biome makes no network requests when it runs through
 * Loxel's manager in a trusted repository, through opening a file, diagnostics and code actions. The
 * config names remote `extends` and plugin URLs too, which Biome must not fetch. macOS only. Run it
 * after changing the manager; it exits non-zero on any outbound attempt.
 *
 *   bun scripts/network-audit/audit-biome-lsp.ts [--control]
 *
 * `--control` also connects out from a process carrying the logger, which `node` on PATH must allow,
 * as Homebrew's does and nodejs.org's hardened one does not. It is the positive control and must fail.
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

const LOXEL = path.resolve(import.meta.dir, "../..");
const REQUEST_TIMEOUT_MS = 60_000;

const { values } = parseArgs({ options: { control: { type: "boolean", default: false } } });

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { uri?: string; diagnostics?: { range: unknown }[]; items?: unknown[] };
  result?: unknown;
  error?: unknown;
}

const CAPABILITIES = {
  textDocument: {
    publishDiagnostics: {},
    codeAction: {
      dynamicRegistration: true,
      resolveSupport: { properties: ["edit"] },
      dataSupport: true,
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["quickfix", "source", "source.fixAll"] },
      },
    },
  },
  workspace: { applyEdit: true, configuration: true },
};

class LspClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: RpcMessage) => void>();
  private diagnosed: (diagnostics: { range: unknown }[]) => void = () => {};
  private warned: () => void = () => {};

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      if (message.method === "textDocument/publishDiagnostics") {
        const diagnostics = message.params?.diagnostics ?? [];
        if (diagnostics.length > 0) this.diagnosed(diagnostics);
      }
      if (message.method === "window/showMessage") this.warned();
      if (message.id === undefined) return;
      if (message.method) {
        const result =
          message.method === "workspace/configuration"
            ? (message.params?.items ?? []).map(() => ({ requireConfiguration: true }))
            : null;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        return;
      }
      const resolve = this.waiting.get(message.id);
      if (typeof resolve === "function") resolve(message);
    });
  }

  request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), REQUEST_TIMEOUT_MS);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Biome's word on a config it could not load, which comes after trying to. */
  warning(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no warning")), REQUEST_TIMEOUT_MS);
      this.warned = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  diagnostics(): Promise<{ range: unknown }[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no diagnostics")), REQUEST_TIMEOUT_MS);
      this.diagnosed = (diagnostics) => {
        clearTimeout(timer);
        resolve(diagnostics);
      };
    });
  }
}

const work = realpathSync(mkdtempSync(path.join(tmpdir(), "audit-biome-")));
const logPath = path.join(work, "connect.log");
const dylib = path.join(work, "connect-log.dylib");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

// The project.
const project = path.join(work, "project");
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(
  path.join(project, "package.json"),
  JSON.stringify({ name: "audit", private: true, devDependencies: { "@biomejs/biome": "^2.6.4" } }),
);
writeFileSync(path.join(project, ".gitignore"), "node_modules\n");
writeFileSync(
  path.join(project, "rule.grit"),
  "`debugger` where { register_diagnostic(span=$_) }\n",
);
const source = "import { b } from './b';\nimport { a } from './a';\nvar c = a + b;\ndebugger;\n";
writeFileSync(path.join(project, "src/a.js"), source);
await $`npm install --ignore-scripts --no-audit --no-fund --silent`.cwd(project);
await $`git init -q && git add -A && git -c user.email=a@example.com -c user.name=audit commit -qm init`.cwd(
  project,
);

// The project's binary, as a script that loads the logger before it; the daemon inherits that.
const native = path.join(
  project,
  "node_modules/@biomejs",
  `cli-${process.platform}-${process.arch}`,
);
const binary = path.join(native, "biome");
const real = path.join(native, "biome.real");
renameSync(binary, real);
const realNode = (await $`which node`.text()).trim();
const control = values.control
  ? `'${realNode}' -e 'require("node:net").connect(443, "1.1.1.1").on("error", () => {})'\n`
  : "";
writeFileSync(
  binary,
  `#!/bin/bash\nexport DYLD_INSERT_LIBRARIES='${dylib}' CONNECT_LOG='${logPath}'\n${control}exec '${real}' "$@"\n`,
  { mode: 0o755 },
);

const dekFile = path.join(work, "dek");
writeFileSync(dekFile, randomBytes(32).toString("base64"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, "src/server/index.ts"], {
  cwd: LOXEL,
  stdout: "ignore",
  stderr: "ignore",
  env: {
    ...process.env,
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

async function post(route: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
}

/** Open a session on the given config, lint a file, ask for its fixes, and close the session. */
async function session(config: unknown, label: string, expectLint: boolean): Promise<void> {
  writeFileSync(path.join(project, "biome.json"), JSON.stringify(config));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/biome-lsp?wt=${encodeURIComponent(project)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const client = new LspClient(ws);
  await client.request("initialize", {
    processId: null,
    rootUri: null,
    capabilities: CAPABILITIES,
  });
  const warned = client.warning();
  client.notify("initialized", {});
  const uri = `loxel://head${path.join(project, "src/a.js")}`;
  const textDocument = { uri };
  const pushed = client.diagnostics();
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "javascript", version: 1, text: source },
  });
  if (expectLint) {
    const items = await pushed;
    check(items.length > 0, `Biome lints (${label})`, items.length);
    const actions = (
      await client.request("textDocument/codeAction", {
        textDocument,
        range: items[0]?.range,
        context: { diagnostics: items },
      })
    ).result as unknown[];
    check(actions.length > 0, `Biome offers code actions (${label})`, actions.length);
    const fixAll = (
      await client.request("textDocument/codeAction", {
        textDocument,
        range: items[0]?.range,
        context: { diagnostics: [], only: ["source.fixAll"] },
      })
    ).result as { kind?: string }[];
    check(fixAll[0]?.kind === "source.fixAll.biome", `Biome offers Fix All (${label})`);
  } else {
    await warned;
    check(true, `Biome tried the config and declined it (${label})`);
  }
  ws.close();
}

try {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (
    !(await fetch(base).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error("The server did not start");
    await Bun.sleep(100);
  }
  await post("/api/projects", { path: project });
  await post("/api/repo-trust", { worktreePath: project, trusted: true });
  await session(
    { $schema: "https://example.com/schema.json", plugins: ["./rule.grit"] },
    "a plain config",
    true,
  );
  await session(
    { extends: ["https://example.com/remote.json"], plugins: ["https://example.com/r.grit"] },
    "remote URLs",
    false,
  );
} finally {
  server.kill();
  await server.exited;
}

const lines = readFileSync(logPath, { flag: "a+", encoding: "utf8" }).split("\n").filter(Boolean);
check(
  lines.some((line) => line.includes(" loaded ")),
  "the logger was in the process",
);
const outbound = lines.filter((line) => line.endsWith(" BLOCKED"));
for (const line of outbound) console.log(line);
check(outbound.length === 0, "no outbound connection attempts", outbound.length);
rmSync(work, { recursive: true, force: true });
process.exit(failures.length > 0 ? 1 : 0);
