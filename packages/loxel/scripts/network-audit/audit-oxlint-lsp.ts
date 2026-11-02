/**
 * Proves at the socket level that a project's oxlint makes no network requests when it runs through
 * Loxel's manager in a trusted repository, through opening a file, diagnostics and code actions.
 * macOS only. Run it after changing the manager; it exits non-zero on any outbound attempt.
 *
 *   bun scripts/network-audit/audit-oxlint-lsp.ts [--control]
 *
 * `node` on PATH must allow DYLD, as Homebrew's does and nodejs.org's hardened one does not.
 * `--control` adds a project plugin that connects out. It is the positive control and must fail.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const CAPABILITIES = {
  textDocument: {
    diagnostic: { dynamicRegistration: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["quickfix", "source", "source.fixAll"] },
      },
    },
  },
  workspace: { applyEdit: true, diagnostics: { refreshSupport: true } },
};

class LspClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: RpcMessage) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      if (message.id === undefined) return;
      if (message.method) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { applied: true } }));
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
}

const work = realpathSync(mkdtempSync(path.join(tmpdir(), "audit-oxlint-")));
const logPath = path.join(work, "connect.log");
const dylib = path.join(work, "connect-log.dylib");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

// The project.
const project = path.join(work, "project");
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(
  path.join(project, "package.json"),
  JSON.stringify({ name: "audit", private: true, devDependencies: { oxlint: "^1.86.0" } }),
);
writeFileSync(path.join(project, ".gitignore"), "node_modules\n");
writeFileSync(
  path.join(project, "control.mjs"),
  `import net from "node:net";\nnet.connect(443, "1.1.1.1").on("error", () => {});\nexport default { meta: { name: "control" }, rules: {} };\n`,
);
writeFileSync(
  path.join(project, ".oxlintrc.json"),
  JSON.stringify({
    ...(values.control ? { jsPlugins: ["./control.mjs"] } : {}),
    rules: { "no-var": "error", "no-unused-vars": "off" },
  }),
);
const source = "var a = 1;\nconsole.log(a);\n";
writeFileSync(path.join(project, "src/a.js"), source);
await $`npm install --ignore-scripts --no-audit --no-fund --silent`.cwd(project);
await $`git init -q && git add -A && git -c user.email=a@example.com -c user.name=audit commit -qm init`.cwd(
  project,
);

// A `node` that loads the logger, the only one on the login shell's PATH of a home of its own.
const realNode = (await $`which node`.text()).trim();
const home = path.join(work, "home");
const bin = path.join(home, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  path.join(bin, "node"),
  `#!/bin/bash\nexport DYLD_INSERT_LIBRARIES='${dylib}' CONNECT_LOG='${logPath}'\nexec '${realNode}' "$@"\n`,
  { mode: 0o755 },
);
for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile"]) {
  writeFileSync(path.join(home, file), `export PATH='${bin}':/usr/bin:/bin\n`);
}

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
    HOME: home,
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

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/oxlint-lsp?wt=${encodeURIComponent(project)}`,
  );
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
  client.notify("initialized", {});
  const uri = `loxel://head${path.join(project, "src/a.js")}`;
  const textDocument = { uri };
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "javascript", version: 1, text: source },
  });
  const report = (await client.request("textDocument/diagnostic", { textDocument })).result as {
    items: { range: unknown }[];
  };
  check(report.items.length === 1, "oxlint lints", report.items.length);
  const actions = (
    await client.request("textDocument/codeAction", {
      textDocument,
      range: report.items[0]?.range,
      context: { diagnostics: report.items },
    })
  ).result as unknown[];
  check(actions.length > 0, "oxlint offers code actions", actions.length);
  const fixAll = (
    await client.request("textDocument/codeAction", {
      textDocument,
      range: report.items[0]?.range,
      context: { diagnostics: [], only: ["source.fixAll"] },
    })
  ).result as { kind?: string }[];
  check(fixAll[0]?.kind === "source.fixAll.oxc", "oxlint offers Fix All", fixAll[0]?.kind);
  ws.close();
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
