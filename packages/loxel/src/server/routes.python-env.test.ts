import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PythonEnvCandidatesResponse, PythonEnvResponse } from "@/api/python-env-model";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-python-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { getPythonOverride } = await import("./python-override-store");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;

const root = await realpath(await mkdtemp(join(tmpdir(), "routes-python-env-")));
const wt = join(root, "wt");
const project = { cwd: wt } as ProjectState;
const ctx = {
  findProjectForPath: (path: string) =>
    path === wt || path.startsWith(`${wt}/`) ? project : undefined,
} as RouteContext;

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

async function writeExecutable(filePath: string, script: string): Promise<string> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, script);
  await chmod(filePath, 0o755);
  return filePath;
}

/** A venv whose interpreter answers `--version` like CPython. */
async function makeVenv(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pyvenv.cfg"), "home = /usr/bin\n");
  return writeExecutable(join(dir, "bin", "python"), `#!/bin/sh\necho "Python 3.12.13"\n`);
}

function setOverride(pythonPath: unknown): Promise<Response> {
  return handleRequest(
    new Request("http://x/api/python-env/override", {
      method: "POST",
      body: JSON.stringify({ worktreePath: wt, pythonPath }),
    }),
    ctx,
  );
}

async function get<T>(route: string): Promise<T> {
  const res = await handleRequest(
    new Request(`http://x${route}?wt=${encodeURIComponent(wt)}`),
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

beforeEach(async () => {
  await rm(wt, { recursive: true, force: true });
  await mkdir(wt, { recursive: true });
  Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
  await setOverride(null);
});

describe("Python interpreter routes", () => {
  test("stores a chosen interpreter, reports it, and clears it", async () => {
    const venvPython = await makeVenv(join(wt, ".venv"));
    const picked = await makeVenv(join(root, "picked"));

    const res = await setOverride(join(root, "picked"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PythonEnvResponse;
    expect(body).toEqual({
      env: {
        source: "override",
        pythonPath: picked,
        envPath: join(root, "picked"),
        version: "3.12.13",
      },
      overridePath: picked,
    });
    expect(getPythonOverride(wt)).toBe(picked);

    const choices = await get<PythonEnvCandidatesResponse>("/api/python-env/candidates");
    expect(choices.automaticPath).toBe(venvPython);
    expect(choices.overridePath).toBe(picked);
    expect(choices.candidates.map((c) => c.pythonPath)).toContain(picked);

    expect((await setOverride(null)).status).toBe(200);
    const cleared = await get<PythonEnvResponse>("/api/python-env");
    expect(cleared.overridePath).toBeNull();
    expect(cleared.env?.pythonPath).toBe(venvPython);
  });

  test("rejects what is not a usable Python interpreter", async () => {
    const reject = async (pythonPath: unknown, message: string) => {
      const res = await setOverride(pythonPath);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    };
    await reject(42, "pythonPath must be a string or null");
    await reject("venv/bin/python", "absolute");
    await reject(join(root, "missing", "python"), "No executable Python interpreter");
    await reject(await writeExecutable(join(root, "tool"), "#!/bin/sh\n"), "Python version");

    const tracked = await makeVenv(join(wt, "committed"));
    Bun.spawnSync(["git", "-C", wt, "add", "committed"]);
    await reject(tracked, "tracks in git");
    expect(getPythonOverride(wt)).toBeNull();
  });

  test("refuses a path that is not a worktree of the project", async () => {
    const res = await handleRequest(
      new Request("http://x/api/python-env/override", {
        method: "POST",
        body: JSON.stringify({ worktreePath: join(wt, "sub"), pythonPath: null }),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
