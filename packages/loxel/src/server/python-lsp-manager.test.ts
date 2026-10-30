import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

import type { ExternalTypeChecker } from "./python-lsp-manager";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "python-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { PythonLspManager, pythonSettings } = await import("./python-lsp-manager");
const { setPythonOverride } = await import("./python-override-store");
const { refreshPythonEnv } = await import("./python-env");

// Drives the real basedpyright through the manager the way the Monaco client does, against a real
// virtual environment holding a package that exists nowhere else.

const python3 = Bun.which("python3");
// The dev-mode basedpyright-langserver is a Node script.
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
  severity?: number;
}

interface CompletionItem {
  label: string;
  insertTextFormat?: number;
  textEdit?: { newText: string };
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly responses = new Map<number, (result: unknown) => void>();
  private diagnosticsWaiter: (() => void) | null = null;
  private nextId = 100;
  /** Methods of the requests the server sent. */
  readonly serverRequests: string[] = [];

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

  /** `pull`: ask for diagnostics (`textDocument/diagnostic`) like Monaco does, instead of having them pushed. */
  async start(wtPath: string, { pull = false } = {}): Promise<void> {
    this.manager.createSession(this.ws, wtPath);
    const rootUri = `file://${wtPath}`;
    const textDocument = {
      publishDiagnostics: {},
      completion: { completionItem: { snippetSupport: true } },
      ...(pull ? { diagnostic: { dynamicRegistration: true } } : {}),
    };
    await this.request(1, "initialize", {
      processId: null,
      rootUri,
      capabilities: { textDocument, workspace: {} },
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

  /** Pull `uri`'s diagnostics until they satisfy `predicate`; the server answers once analyzed. */
  async pullDiagnostics(
    uri: string,
    predicate: (diagnostics: Diagnostic[]) => boolean,
  ): Promise<Diagnostic[]> {
    while (true) {
      const result = (await this.request(this.nextId++, "textDocument/diagnostic", {
        textDocument: { uri },
        previousResultId: "stale",
      })) as { items?: Diagnostic[] };
      const items = result.items ?? [];
      if (predicate(items)) return items;
    }
  }

  /** Ask for completions until there are some; the server has none while it is still loading. */
  async completionItems(uri: string, line: number, character: number): Promise<CompletionItem[]> {
    while (true) {
      const result = (await this.request(this.nextId++, "textDocument/completion", {
        textDocument: { uri },
        position: { line, character },
      })) as { items?: CompletionItem[] };
      if (result.items?.length) return result.items;
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
      this.serverRequests.push(message.method);
      // Answered like monaco-lsp-client does: basedpyright stops answering pulls after a failed refresh.
      if (
        message.method === "client/registerCapability" ||
        message.method === "workspace/diagnostic/refresh"
      ) {
        this.send({ id: message.id, result: null });
        return;
      }
      // Server→client requests the client doesn't implement, like monaco-lsp-client.
      this.send({ id: message.id, error: { code: -32601, message: "Unhandled method" } });
      return;
    }
    if (message.id !== undefined) this.responses.get(message.id)?.(message.result ?? {});
  }
}

async function makeWorktree(): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "python-lsp-")));
  const wt = join(root, "wt");
  await mkdir(wt);
  await writeFile(
    join(wt, "main.py"),
    // `len(...)` as a statement is flagged only by basedpyright's `recommended` ruleset.
    `import ${PACKAGE}\n\nprint(${PACKAGE}.VALUE)\nlen("unused")\n${SENTINEL}\n`,
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
const hasUnusedCallResult = (diagnostics: Diagnostic[]) =>
  diagnostics.some((d) => d.code === "reportUnusedCallResult");

/** A type checker standing in for mypy, owning every file once `owns` is set. */
class FakeTypeChecker implements ExternalTypeChecker {
  owns = false;
  private readonly listeners = new Set<(wtPath: string) => void>();

  ownsTypeChecking(): boolean {
    return this.owns;
  }

  onTypeCheckingChange(listener: (wtPath: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(wtPath: string, owns: boolean): void {
    this.owns = owns;
    for (const listener of this.listeners) listener(wtPath);
  }
}

/** A manager whose resolver found no interpreter, as on a machine without Python outside the repo. */
class UnresolvedEnvManager extends PythonLspManager {
  protected override async workspaceConfiguration(
    session: Parameters<InstanceType<typeof PythonLspManager>["workspaceConfiguration"]>[0],
    section: string | undefined,
  ): Promise<unknown> {
    if (section === "python") return pythonSettings(null, session.wtPath);
    return super.workspaceConfiguration(session, section);
  }
}

/** Start a client on `wt` and wait for the first finished analysis of main.py. */
async function analyzeMain(
  wt: string,
  create = () => new PythonLspManager(),
): Promise<Diagnostic[]> {
  manager = create();
  const client = new FakeClient(manager);
  await client.start(wt);
  const uri = client.open(join(wt, "main.py"), await Bun.file(join(wt, "main.py")).text());
  return client.waitForDiagnostics(uri, analyzed);
}

describe.skipIf(!canRun)("PythonLspManager with basedpyright", () => {
  test(
    "gets method overrides in plain text, so default values reach the editor unexpanded",
    async () => {
      const wt = await makeWorktree();
      manager = new PythonLspManager();
      const client = new FakeClient(manager);
      await client.start(wt);
      await writeFile(join(wt, "base.py"), `class Base:\n    def run(self, x="$HOME"): ...\n`);
      const text = `from base import Base\nclass Sub(Base):\n    def ru\n`;
      const uri = client.open(join(wt, "sub.py"), text);
      const [run] = await client.completionItems(uri, 2, 10);
      expect(run?.textEdit?.newText).toContain("$HOME");
      expect(run?.insertTextFormat).not.toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "resolves imports installed only in the worktree's .venv",
    async () => {
      const wt = await makeWorktree();
      await makeVenvWithPackage(join(wt, ".venv"));
      const diagnostics = await analyzeMain(wt);
      expect(hasMissingImport(diagnostics)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "never runs a .venv interpreter the resolver did not choose",
    async () => {
      const wt = await makeWorktree();
      const marker = join(wt, "ran");
      const bin = join(wt, ".venv", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(wt, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
      await writeFile(
        join(bin, "python"),
        `#!/bin/sh\ntouch '${marker}'\nexec '${python3}' "$@"\n`,
      );
      await chmod(join(bin, "python"), 0o755);
      await analyzeMain(wt, () => new UnresolvedEnvManager());
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "defaults to the standard ruleset",
    async () => {
      const wt = await makeWorktree();
      expect(hasUnusedCallResult(await analyzeMain(wt))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "lets a project config file choose the ruleset",
    async () => {
      const wt = await makeWorktree();
      await writeFile(join(wt, "pyrightconfig.json"), `{ "typeCheckingMode": "recommended" }\n`);
      expect(hasUnusedCallResult(await analyzeMain(wt))).toBe(true);
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
      refreshPythonEnv(wt);
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

  test(
    "drops its type errors where another checker type-checks, unless the project configures it",
    async () => {
      const wt = await makeWorktree();
      const file = join(wt, "checked.py");
      await writeFile(file, `import os\n${SENTINEL}\n\ndef broken(:\n    pass\n`);
      const checker = new FakeTypeChecker();
      manager = new PythonLspManager(checker);
      const client = new FakeClient(manager);
      await client.start(wt, { pull: true });
      const uri = client.open(file, await Bun.file(file).text());
      await client.pullDiagnostics(uri, analyzed);

      checker.set(wt, true);
      // The client is asked to pull again; its answer never reaches basedpyright.
      expect(client.serverRequests).toContain("workspace/diagnostic/refresh");
      const owned = await client.pullDiagnostics(uri, () => true);
      expect(analyzed(owned)).toBe(false);
      // Syntax errors (no rule) and hints (unused import) stay.
      expect(owned.some((d) => d.code === undefined)).toBe(true);
      expect(owned.some((d) => d.code === "reportUnusedImport" && d.severity === 4)).toBe(true);

      // A project that configures basedpyright wants its type errors next to the other checker's.
      await writeFile(join(wt, "pyrightconfig.json"), "{}\n");
      await client.pullDiagnostics(uri, analyzed);
    },
    TEST_TIMEOUT_MS,
  );
});
