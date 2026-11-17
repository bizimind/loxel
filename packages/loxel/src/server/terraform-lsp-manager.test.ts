import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { builtBinaryExists } from "@/test/built-binary";

import { GO_VERSION } from "../../scripts/go-toolchain";

// Before the imports that read it: trust is stored in the state directory.
const stateDir = await mkdtemp(join(tmpdir(), "terraform-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { TerraformLspManager } = await import("./terraform-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

const RESTRICTION =
  "Terraform doesn't run, so provider schemas come from terraform-ls's built-in set.";
const ORIGINAL_PATH = process.env.PATH;
const canRun = process.platform !== "win32";

/** The test's scratch directory; empty until a test makes one. */
let root = "";
let manager: InstanceType<typeof TerraformLspManager> | undefined;

const ORIGINAL_PROXY = process.env.HTTPS_PROXY;
const ORIGINAL_NO_PROXY = process.env.NO_PROXY;
const USER_PROXY = "http://user-proxy:3128";

/** Restores `name` in `process.env` to `value`, which may be unset. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH;
  restoreEnv("HTTPS_PROXY", ORIGINAL_PROXY);
  restoreEnv("NO_PROXY", ORIGINAL_NO_PROXY);
  await manager?.destroy();
  manager = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A manager whose terraform-ls is `server`. */
class ManagerWith extends TerraformLspManager {
  constructor(
    private readonly server: string,
    shimDir: string,
  ) {
    super(shimDir);
  }

  protected override resolveBundledBinary(): string | null {
    return this.server;
  }
}

/**
 * Starts a session for a worktree with a `terraform` on `PATH` and the user's own proxy settings,
 * and returns the `terraform` the server would find, the server's proxy settings and the proxy
 * settings that `terraform` gets, written by a stand-in terraform-ls into a FIFO, so reading it
 * waits for it.
 */
async function terraformSeenByServer(trusted: boolean): Promise<{ wt: string; seen: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "terraform-lsp-")));
  const wt = join(root, "wt");
  const tools = join(root, "tools");
  await mkdir(wt);
  await mkdir(tools);
  await writeFile(join(tools, "terraform"), '#!/bin/sh\necho "$HTTPS_PROXY $NO_PROXY"\n');
  await chmod(join(tools, "terraform"), 0o755);
  const fifo = join(root, "seen");
  Bun.spawnSync(["mkfifo", fifo]);
  const server = join(root, "terraform-ls");
  await writeFile(
    server,
    `#!/bin/sh\necho "found=$(command -v terraform) tfenv=$TFENV_AUTO_INSTALL proxy=$HTTPS_PROXY no_proxy=$NO_PROXY terraform=$(terraform 2>/dev/null)" > '${fifo}'\ncat > /dev/null\n`,
  );
  await chmod(server, 0o755);
  process.env.PATH = `${tools}:/usr/bin:/bin`;
  process.env.HTTPS_PROXY = USER_PROXY;
  process.env.NO_PROXY = "registry.terraform.io";
  if (trusted) setRepoTrusted(wt, true);

  manager = new ManagerWith(server, join(root, "shim"));
  const ws = { send: () => 0, close: () => {}, data: {} } as unknown as ServerWebSocket<unknown>;
  manager.createSession(ws, wt);
  // Read off the main thread: opening a FIFO blocks until the server opens it to write.
  return { wt, seen: (await readFile(fifo, "utf8")).trim() };
}

// Trusted or not, the server's registry lookups go to a proxy that leads nowhere, while the user's
// `terraform` keeps their own proxy settings.
describe.skipIf(!canRun)("TerraformLspManager and repository trust", () => {
  test("an untrusted repository's server finds no terraform, and says so", async () => {
    const { wt, seen } = await terraformSeenByServer(false);
    expect(seen).toBe("found= tfenv= proxy=http://127.0.0.1:9 no_proxy= terraform=");
    expect(getRepoTrustStatus(wt).restrictions).toEqual([RESTRICTION]);
  });

  test("a trusted repository's server runs the user's terraform with their proxy, installing nothing", async () => {
    const { wt, seen } = await terraformSeenByServer(true);
    expect(seen).toBe(
      `found=${join(root, "shim", "terraform")} tfenv=false proxy=http://127.0.0.1:9 no_proxy= ` +
        `terraform=${USER_PROXY} registry.terraform.io`,
    );
    // The shim holds the user's proxy settings, which can carry credentials.
    expect((await stat(join(root, "shim"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "shim", "terraform"))).mode & 0o777).toBe(0o700);
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
  });
});

// The rest runs the real bundled terraform-ls (`pnpm run build:language-servers terraform-ls`)
// behind the manager, the way Monaco's client talks to it.

const BUNDLED_TERRAFORM_LS = resolve(import.meta.dir, "../../build/terraform-ls");
const REAL_SERVER_TIMEOUT_MS = 30_000;

interface LspMessage {
  id?: number;
  method?: string;
  params?: { uri?: string; diagnostics?: { message: string }[] };
  result?: unknown;
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  private nextId = 1;
  private readonly responses = new Map<number, (result: unknown) => void>();
  private readonly diagnosticsListeners = new Map<string, (messages: string[]) => void>();

  constructor(private readonly server: InstanceType<typeof TerraformLspManager>) {
    const ws = { send: (data: string) => this.receive(data), close: () => {}, data: {} };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  async start(wtPath: string): Promise<{ capabilities: Record<string, unknown> }> {
    this.server.createSession(this.ws, wtPath);
    const result = await this.request("initialize", {
      processId: null,
      capabilities: {
        textDocument: { completion: {}, hover: {}, publishDiagnostics: {} },
        // The manager sends the worktree as the workspace folder.
        workspace: { workspaceFolders: true },
      },
    });
    this.send({ method: "initialized", params: {} });
    return result as { capabilities: Record<string, unknown> };
  }

  /** Opens `filePath` and resolves with the first diagnostics the server publishes for it. */
  open(filePath: string, text: string): { uri: string; diagnostics: Promise<string[]> } {
    const uri = pathToFileURL(filePath).href;
    const diagnostics = new Promise<string[]>((resolveDiagnostics) => {
      this.diagnosticsListeners.set(uri, resolveDiagnostics);
    });
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "terraform", version: 1, text } },
    });
    return { uri, diagnostics };
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveResult) => {
      this.responses.set(id, resolveResult);
      this.send({ id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.server.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(data: string): number {
    const message = JSON.parse(data) as LspMessage;
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
      const messages = (message.params.diagnostics ?? []).map((d) => d.message);
      this.diagnosticsListeners.get(message.params.uri)?.(messages);
      this.diagnosticsListeners.delete(message.params.uri);
    } else if (message.method !== undefined && message.id !== undefined) {
      this.send({ id: message.id, result: null });
    } else if (message.id !== undefined) {
      this.responses.get(message.id)?.(message.result);
    }
    return data.length;
  }
}

describe.skipIf(!canRun || !(await builtBinaryExists(BUNDLED_TERRAFORM_LS)))(
  "TerraformLspManager with terraform-ls",
  () => {
    test("is built with Loxel's pinned Go toolchain", () => {
      const { stdout } = Bun.spawnSync([BUNDLED_TERRAFORM_LS, "version"]);
      expect(stdout.toString()).toContain(`go: go${GO_VERSION}`);
    });

    test(
      "reports syntax errors, completes and hovers in a worktree",
      async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), "terraform-lsp-")));
        const mainTf = join(root, "main.tf");
        const text = 'variable "region" {\n  type = string\n}\n\n';
        await writeFile(mainTf, text);
        // In a module of its own: terraform-ls validates a module when it first loads it.
        const brokenTf = join(root, "broken", "main.tf");
        const brokenText = 'variable "x" {\n  type =\n}\n';
        await mkdir(join(root, "broken"));
        await writeFile(brokenTf, brokenText);
        manager = new TerraformLspManager(join(root, "shim"));
        const client = new FakeClient(manager);

        const { capabilities } = await client.start(root);
        // TextMate grammars own highlighting.
        expect(capabilities.semanticTokensProvider).toBeUndefined();
        expect(await client.open(brokenTf, brokenText).diagnostics).not.toEqual([]);

        const { uri } = client.open(mainTf, text);
        const completion = (await client.request("textDocument/completion", {
          textDocument: { uri },
          position: { line: 4, character: 0 },
        })) as { items: { label: string }[] };
        expect(completion.items.map((item) => item.label)).toEqual(
          expect.arrayContaining(["module", "resource", "variable"]),
        );

        const hover = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: 1, character: 3 },
        })) as { contents: { value: string } } | null;
        expect(hover?.contents.value).toContain("type");
      },
      REAL_SERVER_TIMEOUT_MS,
    );
  },
);
