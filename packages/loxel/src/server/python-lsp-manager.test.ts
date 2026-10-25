import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "python-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { PythonLspManager } = await import("./python-lsp-manager");
const { setPythonOverride } = await import("./python-override-store");

// Drives the real Pyright through the manager the way the Monaco client does, against a real
// virtual environment holding a package that exists nowhere else.

const python3 = Bun.which("python3");
// The dev-mode pyright-langserver is a Node script.
const canRun = python3 !== null && Bun.which("node") !== null;
const TEST_TIMEOUT_MS = 60_000;
const DIAGNOSTICS_TIMEOUT_MS = 30_000;
const PACKAGE = "loxel_only_in_venv";
const MISSING_IMPORT = `Import "${PACKAGE}" could not be resolved`;
/** A deliberate type error, so a diagnostics set that contains it comes from a finished analysis. */
const SENTINEL = `sentinel: int = "not an int"`;

let root: string | undefined;
let manager: InstanceType<typeof PythonLspManager> | undefined;

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

interface Diagnostic {
  message: string;
  code?: string;
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly responses = new Map<number, (result: unknown) => void>();
  private diagnosticsWaiter: (() => void) | null = null;

  constructor(private readonly manager: InstanceType<typeof PythonLspManager>) {
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
    const rootUri = `file://${wtPath}`;
    await this.request(1, "initialize", {
      processId: null,
      rootUri,
      capabilities: { textDocument: { publishDiagnostics: {} }, workspace: {} },
      workspaceFolders: [{ uri: rootUri, name: "wt" }],
    });
    this.send({ method: "initialized", params: {} });
  }

  open(filePath: string, text: string): string {
    const uri = `file://${filePath}`;
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "python", version: 1, text } },
    });
    return uri;
  }

  /** Resolve once the latest diagnostics for `uri` satisfy `predicate`. */
  async waitForDiagnostics(
    uri: string,
    predicate: (diagnostics: Diagnostic[]) => boolean,
  ): Promise<Diagnostic[]> {
    const deadline = Date.now() + DIAGNOSTICS_TIMEOUT_MS;
    while (true) {
      const current = this.diagnostics.get(uri);
      if (current && predicate(current)) return current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for diagnostics: ${JSON.stringify(current)}`);
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          this.diagnosticsWaiter = resolve;
        }),
        Bun.sleep(remaining),
      ]);
    }
  }

  private request(id: number, method: string, params: unknown): Promise<unknown> {
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
      params?: { uri: string; diagnostics: Diagnostic[] };
      result?: unknown;
    };
    if (message.method === "textDocument/publishDiagnostics" && message.params) {
      this.diagnostics.set(message.params.uri, message.params.diagnostics);
      this.diagnosticsWaiter?.();
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // Server→client requests the client doesn't implement, like monaco-lsp-client.
      this.send({ id: message.id, error: { code: -32601, message: "Unhandled method" } });
      return;
    }
    if (message.id !== undefined) this.responses.get(message.id)?.(message.result);
  }
}

async function makeWorktree(): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "python-lsp-")));
  const wt = join(root, "wt");
  await mkdir(wt);
  await writeFile(
    join(wt, "main.py"),
    `import ${PACKAGE}\n\nprint(${PACKAGE}.VALUE)\n${SENTINEL}\n`,
  );
  return wt;
}

/**
 * A real venv (no pip, so no network) with `PACKAGE` installed into its site-packages, at
 * `venv`. Returns its interpreter.
 */
async function makeVenvWithPackage(venv: string): Promise<string> {
  const created = Bun.spawnSync([python3!, "-m", "venv", "--without-pip", venv]);
  if (created.exitCode !== 0) throw new Error(`venv creation failed: ${created.stderr}`);
  const [pythonDir] = (await readdir(join(venv, "lib"))).filter((n) => n.startsWith("python"));
  const pkg = join(venv, "lib", pythonDir!, "site-packages", PACKAGE);
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "__init__.py"), "VALUE = 1\n");
  return join(venv, "bin", "python");
}

const hasMissingImport = (diagnostics: Diagnostic[]) =>
  diagnostics.some((d) => d.message.includes(MISSING_IMPORT));
const analyzed = (diagnostics: Diagnostic[]) =>
  diagnostics.some((d) => d.code === "reportAssignmentType");

describe.skipIf(!canRun)("PythonLspManager with Pyright", () => {
  test(
    "resolves imports installed only in the worktree's .venv",
    async () => {
      const wt = await makeWorktree();
      await makeVenvWithPackage(join(wt, ".venv"));
      manager = new PythonLspManager();
      const client = new FakeClient(manager);
      await client.start(wt);

      const uri = client.open(join(wt, "main.py"), await Bun.file(join(wt, "main.py")).text());
      const diagnostics = await client.waitForDiagnostics(uri, analyzed);
      expect(hasMissingImport(diagnostics)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "picks up a .venv created after the server started",
    async () => {
      const wt = await makeWorktree();
      manager = new PythonLspManager();
      const client = new FakeClient(manager);
      await client.start(wt);

      const uri = client.open(join(wt, "main.py"), await Bun.file(join(wt, "main.py")).text());
      await client.waitForDiagnostics(uri, (d) => analyzed(d) && hasMissingImport(d));

      await makeVenvWithPackage(join(wt, ".venv"));
      await client.waitForDiagnostics(uri, (d) => analyzed(d) && !hasMissingImport(d));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "switches to an interpreter chosen for the worktree without a restart",
    async () => {
      const wt = await makeWorktree();
      const picked = await makeVenvWithPackage(join(root!, "picked"));
      manager = new PythonLspManager();
      const client = new FakeClient(manager);
      await client.start(wt);

      const uri = client.open(join(wt, "main.py"), await Bun.file(join(wt, "main.py")).text());
      await client.waitForDiagnostics(uri, (d) => analyzed(d) && hasMissingImport(d));

      setPythonOverride(wt, picked);
      manager.refreshWorktreeEnvironment(wt);
      await client.waitForDiagnostics(uri, (d) => analyzed(d) && !hasMissingImport(d));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "resolves a module created on disk once the file watcher reports it",
    async () => {
      const wt = await makeWorktree();
      manager = new PythonLspManager();
      const client = new FakeClient(manager);
      await client.start(wt);

      const uri = client.open(join(wt, "main.py"), await Bun.file(join(wt, "main.py")).text());
      await client.waitForDiagnostics(uri, (d) => analyzed(d) && hasMissingImport(d));

      const module = join(wt, `${PACKAGE}.py`);
      await writeFile(module, "VALUE = 1\n");
      manager.notifyWatchedFilesChanged(wt, [module]);
      await client.waitForDiagnostics(uri, (d) => analyzed(d) && !hasMissingImport(d));
    },
    TEST_TIMEOUT_MS,
  );
});
