import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { NodeEnvCandidatesResponse, NodeEnvResponse } from "@/api/node-env-model";

// The tests choose where versions live; the machine's own manager settings must not apply.
for (const name of [
  "NVM_DIR",
  "FNM_DIR",
  "VOLTA_HOME",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "MISE_INSTALLS_DIR",
  "XDG_DATA_HOME",
  "N_PREFIX",
  "N_CACHE_PREFIX",
]) {
  delete process.env[name];
}
// Overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-node-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const root = await realpath(await mkdtemp(join(tmpdir(), "routes-node-env-")));
const home = join(root, "home");
const wt = join(root, "wt");
await mkdir(wt, { recursive: true });
Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
const installed = join(home, ".nvm/versions/node/v22.1.0/bin/node");
await mkdir(dirname(installed), { recursive: true });
await writeFile(installed, "#!/bin/sh\necho v22.1.0\n");
await chmod(installed, 0o755);
const realHome = process.env.HOME;
process.env.HOME = home;

const { handleRequest } = await import("./routes");
const { getNodeOverride } = await import("./node-override-store");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;

const project = { cwd: wt } as ProjectState;
const ctx = {
  findProjectForPath: (path: string) =>
    path === wt || path.startsWith(`${wt}/`) ? project : undefined,
} as RouteContext;

afterAll(async () => {
  process.env.HOME = realHome;
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

function setOverride(nodePath: unknown): Promise<Response> {
  return handleRequest(
    new Request("http://x/api/node-env/override", {
      method: "POST",
      body: JSON.stringify({ worktreePath: wt, nodePath }),
    }),
    ctx,
  );
}

describe("node-env routes", () => {
  test("candidates offer what is installed", async () => {
    const res = await handleRequest(
      new Request(`http://x/api/node-env/candidates?wt=${encodeURIComponent(wt)}`),
      ctx,
    );
    const { candidates } = (await res.json()) as NodeEnvCandidatesResponse;
    expect(candidates).toContainEqual({ nodePath: installed, version: "22.1.0", manager: "nvm" });
  });

  test("a listed node can be chosen and cleared", async () => {
    const chosen = (await (await setOverride(installed)).json()) as NodeEnvResponse;
    expect(chosen.env).toEqual({
      source: "override",
      nodePath: installed,
      version: "22.1.0",
      manager: "nvm",
    });
    expect(getNodeOverride(wt)).toBe(installed);

    const cleared = (await (await setOverride(null)).json()) as NodeEnvResponse;
    expect(cleared.overridePath).toBeNull();
    expect(getNodeOverride(wt)).toBeNull();
  });

  test("anything not listed is refused", async () => {
    const other = join(wt, "node");
    await writeFile(other, "#!/bin/sh\necho v1.0.0\n");
    await chmod(other, 0o755);
    expect((await setOverride(other)).status).toBe(400);
    expect((await setOverride(42)).status).toBe(400);
    expect(getNodeOverride(wt)).toBeNull();
  });
});
