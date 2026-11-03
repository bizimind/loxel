import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH;
  await manager?.destroy();
  manager = undefined;
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A manager whose terraform-ls is `server`. */
class ManagerWith extends TerraformLspManager {
  constructor(private readonly server: string) {
    super();
  }

  protected override resolveBundledBinary(): string | null {
    return this.server;
  }
}

/**
 * Starts a session for a worktree with a `terraform` on `PATH`, and returns the `terraform` the
 * server would find, written by a stand-in terraform-ls into a FIFO, so reading it waits for it.
 */
async function terraformSeenByServer(trusted: boolean): Promise<{ wt: string; seen: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "terraform-lsp-")));
  const wt = join(root, "wt");
  const tools = join(root, "tools");
  await mkdir(wt);
  await mkdir(tools);
  await writeFile(join(tools, "terraform"), "#!/bin/sh\n");
  await chmod(join(tools, "terraform"), 0o755);
  const fifo = join(root, "seen");
  Bun.spawnSync(["mkfifo", fifo]);
  const server = join(root, "terraform-ls");
  await writeFile(
    server,
    `#!/bin/sh\necho "found=$(command -v terraform)" > '${fifo}'\ncat > /dev/null\n`,
  );
  await chmod(server, 0o755);
  process.env.PATH = `${tools}:/usr/bin:/bin`;
  if (trusted) setRepoTrusted(wt, true);

  manager = new ManagerWith(server);
  const ws = { send: () => 0, close: () => {}, data: {} } as unknown as ServerWebSocket<unknown>;
  manager.createSession(ws, wt);
  // Read off the main thread: opening a FIFO blocks until the server opens it to write.
  return { wt, seen: (await readFile(fifo, "utf8")).trim() };
}

describe.skipIf(!canRun)("TerraformLspManager and repository trust", () => {
  test("an untrusted repository's server finds no terraform, and says so", async () => {
    const { wt, seen } = await terraformSeenByServer(false);
    expect(seen).toBe("found=");
    expect(getRepoTrustStatus(wt).restrictions).toEqual([RESTRICTION]);
  });

  test("a trusted repository's server finds the user's terraform", async () => {
    const { wt, seen } = await terraformSeenByServer(true);
    expect(seen).toBe(`found=${join(root, "tools", "terraform")}`);
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
  });
});
