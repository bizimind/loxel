import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CSharpSolutionsResponse, CSharpStatusResponse } from "@/api/csharp-env-model";

// The choice and trust live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-csharp-status-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { getCSharpSolution, csharpSolutionStoreKey } = await import("./csharp-solution-store");
const { publishCSharpLspState } = await import("./csharp-lsp-state");
const { getStore } = await import("./store-db");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;

const root = await realpath(await mkdtemp(join(tmpdir(), "routes-csharp-status-")));
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

async function write(file: string, content = ""): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

function choose(solutionPath: unknown): Promise<Response> {
  return handleRequest(
    new Request("http://x/api/csharp-status/solution", {
      method: "POST",
      body: JSON.stringify({ worktreePath: wt, solutionPath }),
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
  await choose(null);
  await rm(wt, { recursive: true, force: true });
  await mkdir(wt, { recursive: true });
  Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
  await write(join(wt, "a/A.sln"));
  await write(join(wt, "b/B.slnx"));
  await write(join(wt, "F.slnf"));
  await write(join(wt, "a/App.csproj"));
});

describe("C# solution routes", () => {
  test("offers solutions and filters, not projects, with what detection loads", async () => {
    const body = await get<CSharpSolutionsResponse>("/api/csharp-status/solutions");
    expect(body).toEqual({
      solutions: [join(wt, "F.slnf"), join(wt, "a/A.sln"), join(wt, "b/B.slnx")],
      automatic: join(wt, "a/A.sln"),
      chosen: null,
      trusted: false,
    });
  });

  test("stores a choice per worktree, reports it, and clears it", async () => {
    const res = await choose(join(wt, "F.slnf"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as CSharpStatusResponse).chosen).toBe(join(wt, "F.slnf"));
    expect(getCSharpSolution(wt)).toBe(join(wt, "F.slnf"));
    expect((await choose(null)).status).toBe(200);
    expect(getStore(csharpSolutionStoreKey(wt))).toBeNull();
  });

  test("refuses what discovery does not list, or that leaves the worktree", async () => {
    await write(join(root, "outside.sln"));
    await symlink(join(root, "outside.sln"), join(wt, "Link.sln"));
    for (const bad of [
      join(root, "outside.sln"),
      join(wt, "a/App.csproj"),
      join(wt, "Missing.sln"),
      "../outside.sln",
      join(wt, "Link.sln"),
      5,
    ]) {
      expect((await choose(bad)).status).toBe(400);
    }
    expect(getCSharpSolution(wt)).toBeNull();
    await rm(join(wt, "Link.sln"));
  });

  test("a relative path inside the worktree is stored as absolute", async () => {
    expect((await choose("a/A.sln")).status).toBe(200);
    expect(getCSharpSolution(wt)).toBe(join(wt, "a/A.sln"));
  });

  test("says when the chosen file is gone", async () => {
    await choose(join(wt, "F.slnf"));
    await rm(join(wt, "F.slnf"));
    const body = await get<CSharpStatusResponse>("/api/csharp-status");
    expect(body.chosenMissing).toBe(true);
    expect(body.chosen).toBe(join(wt, "F.slnf"));
  });

  test("an untrusted repository with no project shows nothing", async () => {
    publishCSharpLspState(wt, { kind: "blocked", block: "untrusted", message: "not trusted" });
    const withProject = await get<CSharpStatusResponse>("/api/csharp-status");
    expect(withProject.server?.kind).toBe("blocked");
    await rm(join(wt, "a/App.csproj"));
    const without = await get<CSharpStatusResponse>("/api/csharp-status");
    expect(without.server?.kind).toBe("no-project");
  });
});
