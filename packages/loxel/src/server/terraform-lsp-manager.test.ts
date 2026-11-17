import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

// Before the imports that read it: trust is stored in the state directory.
const stateDir = await mkdtemp(join(tmpdir(), "terraform-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { TerraformLspManager } = await import("./terraform-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

const RESTRICTION =
  "Terraform doesn't run, so provider schemas come from terraform-ls's built-in set.";
const ORIGINAL_PATH = process.env.PATH;
const canRun = process.platform !== "win32";

let root: string;
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
  await rm(root, { recursive: true, force: true });
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
