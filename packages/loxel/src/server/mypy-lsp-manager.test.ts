import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "mypy-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { MypyLspManager } = await import("./mypy-lsp-manager");
const { fileUri } = await import("./lsp-file-uri");

// Drives the manager the way the Monaco client does, against a worktree whose `.venv` holds a
// stand-in `dmypy`: it records each run's arguments and prints what the test put in `.dmypy-output`,
// exiting with `.dmypy-exit`.

const python3 = Bun.which("python3");
const canRun = python3 !== null && process.platform !== "win32";

const FAKE_DMYPY = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "dmypy 2.4.1"; exit 0; fi
echo "$*" >> "$PWD/.dmypy-runs"
cat "$PWD/.dmypy-output" 2>/dev/null
exit "$(cat "$PWD/.dmypy-exit" 2>/dev/null || echo 1)"
`;

let root: string | undefined;
let manager: InstanceType<typeof MypyLspManager> | undefined;

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

interface Received {
  method?: string;
  id?: number;
  params?: { uri?: string; diagnostics?: { message: string; source: string }[]; type?: number; message?: string };
  result?: unknown;
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  readonly received: Received[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly target: InstanceType<typeof MypyLspManager>) {
    const ws = {
      send: (data: string) => {
        this.received.push(JSON.parse(data) as Received);
        for (const waiter of this.waiters.splice(0)) waiter();
        return data.length;
      },
      close: () => {},
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  async start(wtPath: string): Promise<unknown> {
    this.target.createSession(this.ws, wtPath);
    this.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    const response = await this.waitFor((m) => m.id === 1);
    this.send({ method: "initialized", params: {} });
    return response.result;
  }

  open(file: string): void {
    const textDocument = { uri: fileUri(file), languageId: "python", version: 1, text: "" };
    this.send({ method: "textDocument/didOpen", params: { textDocument } });
  }

  close(file: string): void {
    this.send({ method: "textDocument/didClose", params: { textDocument: { uri: fileUri(file) } } });
  }

  /** The first message received from now on (or already, when `since` is 0) that `predicate` accepts. */
  async waitFor(predicate: (message: Received) => boolean, since = 0): Promise<Received> {
    while (true) {
      const found = this.received.slice(since).find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  diagnosticsFor(file: string): (message: Received) => boolean {
    return (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === fileUri(file);
  }

  private send(message: Record<string, unknown>): void {
    this.target.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }
}

/** A worktree with `files`, and a `.venv` holding the stand-in dmypy unless `withMypy` is false. */
async function makeWorktree(files: Record<string, string>, withMypy = true): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "mypy-lsp-")));
  const wt = join(root, "wt");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(wt, name, ".."), { recursive: true });
    await writeFile(join(wt, name), content);
  }
  const bin = join(wt, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(wt, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  await writeFile(join(bin, "python"), `#!/bin/sh\nexec '${python3}' "$@"\n`);
  await chmod(join(bin, "python"), 0o755);
  if (withMypy) {
    await writeFile(join(bin, "dmypy"), FAKE_DMYPY);
    await chmod(join(bin, "dmypy"), 0o755);
  }
  return wt;
}

function report(file: string, line: number, message: string): string {
  return JSON.stringify({
    file,
    line,
    column: 0,
    end_line: line,
    end_column: 1,
    message,
    hint: null,
    code: "assignment",
    severity: "error",
  });
}

async function runs(dir: string): Promise<string[]> {
  return (await readFile(join(dir, ".dmypy-runs"), "utf-8")).trim().split("\n");
}

describe.skipIf(!canRun)("MypyLspManager", () => {
  test("checks open files of a project configured for mypy and owns their type checking", async () => {
    const wt = await makeWorktree({
      "pyproject.toml": "[tool.mypy]\nstrict = true\n",
      ".dmypy-output": `Daemon started\n${report("main.py", 3, "Incompatible types")}\n`,
    });
    manager = new MypyLspManager();
    const changes: string[] = [];
    manager.onTypeCheckingChange((path) => changes.push(path));
    const client = new FakeClient(manager);
    expect(await client.start(wt)).toEqual({
      capabilities: { textDocumentSync: { openClose: true, change: 0 } },
      serverInfo: { name: "mypy" },
    });

    const main = join(wt, "main.py");
    client.open(main);
    const published = await client.waitFor(client.diagnosticsFor(main));
    expect(published.params?.diagnostics).toMatchObject([
      { message: "Incompatible types", source: "mypy", code: "assignment" },
    ]);
    // The open file is the target, after mypy's output flags.
    expect((await runs(wt))[0]).toEndWith("-- --output json --show-error-end main.py");
    expect(manager.ownsTypeChecking(wt, main)).toBe(true);
    expect(changes).toEqual([wt]);

    // Closing the last file of the project stops it and clears what it published.
    const before = client.received.length;
    client.close(main);
    const cleared = await client.waitFor(client.diagnosticsFor(main), before);
    expect(cleared.params?.diagnostics).toEqual([]);
    expect(manager.ownsTypeChecking(wt, main)).toBe(false);
    expect(changes).toEqual([wt, wt]);
  });

  test("checks what the config names, and re-checks when a Python file changes", async () => {
    const wt = await makeWorktree({
      "services/api/setup.cfg": "[mypy]\nfiles = api\n",
      "services/api/.dmypy-output": `${report("api/models.py", 1, "First")}\n`,
    });
    const api = join(wt, "services", "api");
    manager = new MypyLspManager();
    const client = new FakeClient(manager);
    await client.start(wt);

    client.open(join(api, "api", "app.py"));
    const models = join(api, "api", "models.py");
    await client.waitFor(client.diagnosticsFor(models));
    // No targets: mypy checks the configured files, run from the config's directory.
    expect((await runs(api))[0]).toEndWith("-- --output json --show-error-end");

    await writeFile(join(api, ".dmypy-output"), "");
    const before = client.received.length;
    manager.notifyWatchedFilesChanged(wt, [models]);
    const cleared = await client.waitFor(client.diagnosticsFor(models), before);
    expect(cleared.params?.diagnostics).toEqual([]);
  });

  test("tells the user once when mypy is configured but not installed", async () => {
    const wt = await makeWorktree({ "mypy.ini": "[mypy]\n" }, false);
    manager = new MypyLspManager();
    const client = new FakeClient(manager);
    await client.start(wt);

    client.open(join(wt, "main.py"));
    const notice = await client.waitFor((m) => m.method === "window/showMessage");
    expect(notice.params?.type).toBe(2);
    expect(notice.params?.message).toStartWith(
      "mypy is configured in mypy.ini but is not installed in the worktree's Python environment",
    );
    expect(manager.ownsTypeChecking(wt, join(wt, "main.py"))).toBe(false);
  });

  test("shows what mypy said when it could not check the project", async () => {
    const wt = await makeWorktree({
      "pyproject.toml": "[tool.mypy]\n",
      ".dmypy-output": "pyproject.toml: Invalid value (at line 2, column 10)\n",
      ".dmypy-exit": "2",
    });
    manager = new MypyLspManager();
    const client = new FakeClient(manager);
    await client.start(wt);

    client.open(join(wt, "main.py"));
    const notice = await client.waitFor((m) => m.method === "window/showMessage");
    expect(notice.params).toEqual({
      type: 1,
      message: "mypy could not check the worktree: pyproject.toml: Invalid value (at line 2, column 10)",
    });
  });

  test("ignores files without a mypy config", async () => {
    const wt = await makeWorktree({ "pyproject.toml": "[tool.ruff]\n" });
    manager = new MypyLspManager();
    const client = new FakeClient(manager);
    await client.start(wt);
    client.open(join(wt, "main.py"));
    expect(manager.ownsTypeChecking(wt, join(wt, "main.py"))).toBe(false);
    expect(await Bun.file(join(wt, ".dmypy-runs")).exists()).toBe(false);
  });
});
