import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { $, type ServerWebSocket } from "bun";

import type { PythonEnv } from "@/api/python-env-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

// The shared environment resolution reads interpreter overrides from the store database; keep
// the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "ruff-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { refreshPythonEnv, subscribePythonEnv } = await import("./python-env");
const { pickRuffBinary, RuffLspManager } = await import("./ruff-lsp-manager");

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const roots: string[] = [];
let manager: InstanceType<typeof RuffLspManager> | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** An executable that prints `ruff <version>` like `ruff --version`. */
async function fakeRuff(file: string, version: string): Promise<string> {
  await writeFile(file, `#!/bin/sh\necho "ruff ${version}"\n`);
  await chmod(file, 0o755);
  return file;
}

/** A worktree whose `.venv` holds a fake interpreter and a fake ruff of `version`. */
async function worktreeWithVenvRuff(version: string): Promise<{ wt: string; venvRuff: string }> {
  const wt = await makeDir("ruff-wt-");
  const bin = join(wt, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(wt, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  await fakeRuff(join(bin, "python"), "0");
  return { wt, venvRuff: await fakeRuff(join(bin, "ruff"), version) };
}

/** The environment the resolver reports for {@link worktreeWithVenvRuff}'s `.venv`. */
function venvEnv(wt: string): PythonEnv {
  return {
    source: "venv",
    pythonPath: join(wt, ".venv", "bin", "python"),
    envPath: join(wt, ".venv"),
  };
}

describe.skipIf(process.platform === "win32")("pickRuffBinary", () => {
  test("prefers the ruff installed in the worktree's environment", async () => {
    const { wt, venvRuff } = await worktreeWithVenvRuff("0.9.0");
    const bundled = await fakeRuff(join(await makeDir("ruff-bundled-"), "ruff"), "0.17.2");
    expect((await pickRuffBinary(wt, venvEnv(wt), bundled))?.path).toBe(venvRuff);
  });

  test("falls back to the bundled ruff when the environment's has no stable server", async () => {
    const { wt } = await worktreeWithVenvRuff("0.4.10");
    const bundled = await fakeRuff(join(await makeDir("ruff-bundled-"), "ruff"), "0.17.2");
    expect((await pickRuffBinary(wt, venvEnv(wt), bundled))?.path).toBe(bundled);
  });

  test("never runs a ruff the repository ships", async () => {
    const { wt } = await worktreeWithVenvRuff("0.9.0");
    await $`git init -q ${wt}`.quiet();
    await $`git -C ${wt} add -f -- .venv/bin/ruff`.quiet();
    const bundled = await fakeRuff(join(await makeDir("ruff-bundled-"), "ruff"), "0.17.2");
    expect((await pickRuffBinary(wt, venvEnv(wt), bundled))?.path).toBe(bundled);
  });

  test("never runs a ruff from an environment the repository ships part of", async () => {
    const { wt } = await worktreeWithVenvRuff("0.9.0");
    await $`git init -q ${wt}`.quiet();
    // ruff itself is untracked, but a committed environment can still run repository code.
    await $`git -C ${wt} add -f -- .venv/pyvenv.cfg`.quiet();
    const bundled = await fakeRuff(join(await makeDir("ruff-bundled-"), "ruff"), "0.17.2");
    expect((await pickRuffBinary(wt, venvEnv(wt), bundled))?.path).toBe(bundled);
  });
});

// Drives the bundled ruff (`pnpm run download:ruff`) through the manager the way the Monaco
// client does.

const BUNDLED_RUFF = resolve(import.meta.dir, "../../build/ruff");
const TEST_TIMEOUT_MS = 30_000;

interface LspMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  /** Server→client requests that reached the client. */
  readonly serverRequests: string[] = [];
  /** Resolves with the close code once the manager closes the socket. */
  readonly closed: Promise<number>;
  private nextId = 1;
  private readonly responses = new Map<number, (result: unknown) => void>();

  constructor(private readonly manager: InstanceType<typeof RuffLspManager>) {
    let onClose: (code: number) => void = () => {};
    this.closed = new Promise((resolve) => {
      onClose = resolve;
    });
    const ws = {
      send: (data: string) => {
        this.receive(data);
        return data.length;
      },
      close: (code: number) => onClose(code),
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  /** Sends `initialize` right after connecting, while the manager still resolves ruff. */
  async start(
    wtPath: string,
    capabilities: Record<string, unknown> = {},
  ): Promise<{ capabilities: Record<string, unknown> }> {
    this.manager.createSession(this.ws, wtPath);
    const result = await this.request("initialize", { processId: null, capabilities });
    this.send({ method: "initialized", params: {} });
    return result as { capabilities: Record<string, unknown> };
  }

  open(filePath: string, text: string): string {
    const uri = `file://${filePath}`;
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "python", version: 1, text } },
    });
    return uri;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.responses.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.manager.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(data: string): void {
    const message = JSON.parse(data) as LspMessage;
    if (message.method !== undefined && message.id !== undefined) {
      this.serverRequests.push(message.method);
      this.send({ id: message.id, result: null });
      return;
    }
    if (message.id !== undefined) this.responses.get(message.id)?.(message.result);
  }
}

describe.skipIf(!(await Bun.file(BUNDLED_RUFF).exists()))("RuffLspManager with ruff", () => {
  test(
    "serves lint diagnostics, code actions and config reloads, but neither formatting nor syntax errors",
    async () => {
      const wt = await makeDir("ruff-lsp-");
      await writeFile(join(wt, "pyproject.toml"), "[tool.ruff.lint]\nselect = ['F', 'I']\n");
      manager = new RuffLspManager();
      const client = new FakeClient(manager);

      // Like monaco-lsp-client, so ruff 0.17+ registers formatting dynamically.
      const { capabilities } = await client.start(wt, {
        textDocument: {
          formatting: { dynamicRegistration: true },
          rangeFormatting: { dynamicRegistration: true },
        },
      });
      expect(capabilities.codeActionProvider).toMatchObject({
        codeActionKinds: expect.arrayContaining([
          "source.fixAll.ruff",
          "source.organizeImports.ruff",
        ]),
      });
      expect(capabilities.documentFormattingProvider).toBeUndefined();

      const uri = client.open(join(wt, "app.py"), "import sys\nimport os\ndef f(:\n  pass\n");
      const report = (await client.request("textDocument/diagnostic", {
        textDocument: { uri },
      })) as { items: { code?: string }[] };
      // basedpyright reports syntax errors; ruff only lints.
      expect(report.items.map((d) => d.code)).not.toContain("invalid-syntax");

      const linted = client.open(join(wt, "lint.py"), "import os\nimport sys\n");
      const lint = (await client.request("textDocument/diagnostic", {
        textDocument: { uri: linted },
      })) as { items: { code?: string }[] };
      expect(lint.items.map((d) => d.code)).toEqual(["F401", "F401"]);

      // Ruff registers formatting dynamically; format on save owns Python formatting instead.
      // Its config-file watchers are kept on the server too.
      expect(client.serverRequests).not.toContain("client/registerCapability");

      // An edited config reaches ruff as a watched file, and its diagnostics follow.
      await writeFile(join(wt, "pyproject.toml"), "[tool.ruff.lint]\nselect = ['I']\n");
      manager.notifyWatchedFilesChanged(wt, [join(wt, "pyproject.toml")]);
      const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
      let codes = ["F401"];
      while (codes.length > 0) {
        if (Date.now() > deadline) throw new Error(`ruff kept its old rules: ${codes.join()}`);
        await Bun.sleep(100);
        const report = (await client.request("textDocument/diagnostic", {
          textDocument: { uri: linted },
        })) as { items: { code?: string }[] };
        codes = report.items.map((d) => d.code ?? "");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "suppresses formatting that ruff advertises statically",
    async () => {
      // Without dynamic registration support ruff advertises formatting in its initialize result,
      // the way ruff before 0.17 always does.
      manager = new RuffLspManager();
      const { capabilities } = await new FakeClient(manager).start(await makeDir("ruff-lsp-"));
      expect(capabilities.codeActionProvider).toBeDefined();
      expect(capabilities.documentFormattingProvider).toBeUndefined();
      expect(capabilities.documentRangeFormattingProvider).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "restarts through a client reconnect when the environment gets its own ruff",
    async () => {
      const wt = await makeDir("ruff-lsp-");
      manager = new RuffLspManager();
      const client = new FakeClient(manager);
      // The server's subscription keeps the worktree's resolution shared and watched.
      const unsubscribe = subscribePythonEnv(wt, () => {});
      try {
        await client.start(wt);
        // `uv sync` after the first file opened: a venv with a ruff that serves.
        const bin = join(wt, ".venv", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(join(wt, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
        await fakeRuff(join(bin, "python"), "0");
        await fakeRuff(join(bin, "ruff"), "0.9.0");
        refreshPythonEnv(wt);
        expect(await client.closed).toBe(LSP_RESTART_CLOSE_CODE);
      } finally {
        unsubscribe();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
