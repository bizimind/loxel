import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JavaEnvCandidatesResponse, JavaEnvResponse } from "@/api/java-env-model";

// JDK overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-java-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { getJavaOverride } = await import("./java-override-store");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;

const root = await realpath(await mkdtemp(join(tmpdir(), "routes-java-env-")));
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

afterEach(() => {
  delete process.env.JAVA_HOME;
});

async function makeJdk(dir: string, version = "21.0.5"): Promise<string> {
  await mkdir(join(dir, "bin"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });
  for (const tool of ["java", "javac"]) {
    await writeFile(join(dir, "bin", tool), "#!/bin/sh\n");
    await chmod(join(dir, "bin", tool), 0o755);
  }
  await writeFile(join(dir, "lib", "ct.sym"), "");
  await writeFile(
    join(dir, "release"),
    `IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="${version}"\n`,
  );
  return dir;
}

function setOverride(javaHome: unknown): Promise<Response> {
  return handleRequest(
    new Request("http://x/api/java-env/override", {
      method: "POST",
      body: JSON.stringify({ worktreePath: wt, javaHome }),
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

describe("JDK routes", () => {
  test("stores a chosen JDK, reports it, and clears it", async () => {
    const detected = await makeJdk(join(root, "detected"));
    const picked = await makeJdk(join(root, "picked"), "25.0.1");
    process.env.JAVA_HOME = detected;

    const res = await setOverride(picked);
    expect(res.status).toBe(200);
    expect((await res.json()) as JavaEnvResponse).toEqual({
      env: {
        source: "override",
        path: picked,
        majorVersion: 25,
        version: "25.0.1",
        implementor: "Eclipse Adoptium",
      },
      overridePath: picked,
      ignoredJavaHome: null,
    });
    expect(getJavaOverride(wt)).toBe(picked);

    const choices = await get<JavaEnvCandidatesResponse>("/api/java-env/candidates");
    expect(choices.automatic?.path).toBe(detected);
    expect(choices.overridePath).toBe(picked);
    expect(choices.candidates.map((c) => c.path)).toContain(picked);
    expect(choices.candidates.map((c) => c.path)).toContain(detected);

    expect((await setOverride(null)).status).toBe(200);
    const cleared = await get<JavaEnvResponse>("/api/java-env");
    expect(cleared.overridePath).toBeNull();
    expect(cleared.env?.path).toBe(detected);
  });

  test("says when JAVA_HOME was ignored", async () => {
    const stale = join(root, "opt", "openjdk");
    process.env.JAVA_HOME = stale;
    const { ignoredJavaHome } = await get<JavaEnvResponse>("/api/java-env");
    expect(ignoredJavaHome).toBe(stale);
  });

  test("takes a ~/ path", async () => {
    const res = await setOverride("~/definitely-not-a-jdk-here");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("No JDK at /");
  });

  test("rejects what is not a usable JDK", async () => {
    const reject = async (javaHome: unknown, message: string) => {
      const res = await setOverride(javaHome);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    };
    await reject(42, "javaHome must be a string or null");
    await reject("jdk", "absolute");
    await reject(join(root, "missing"), "No JDK");

    const tracked = await makeJdk(join(wt, "committed"));
    Bun.spawnSync(["git", "-C", wt, "add", "committed"]);
    await reject(tracked, "tracks in git");
    expect(getJavaOverride(wt)).toBeNull();
  });

  test("refuses a path that is not a worktree of the project", async () => {
    const res = await handleRequest(
      new Request("http://x/api/java-env/override", {
        method: "POST",
        body: JSON.stringify({ worktreePath: join(wt, "sub"), javaHome: null }),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    const query = await handleRequest(
      new Request(`http://x/api/java-env?wt=${encodeURIComponent(join(wt, "sub"))}`),
      ctx,
    );
    expect(query.status).toBe(400);
  });
});
