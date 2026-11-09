import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  RustToolchainCandidatesResponse,
  RustToolchainResponse,
} from "@/api/rust-toolchain-model";

// Each test spawns git and fake tools; on a loaded machine that takes far longer than the default.
setDefaultTimeout(120_000);

// The fakes here are scripts, which the lookup refuses; `rust-tool-shim.test.ts` covers that.
mock.module("./rust-tool-shim", () => ({ isVersionManagerShim: async () => false }));

// Choices live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "routes-rust-toolchain-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { handleRequest } = await import("./routes");
const { getRustChoice } = await import("./rust-toolchain-store");
type RouteContext = import("./routes").RouteContext;
type ProjectState = import("./server-state").ProjectState;

const STABLE = "stable-aarch64-apple-darwin";
const PINNED = "1.90.0-aarch64-apple-darwin";

const root = await realpath(await mkdtemp(join(tmpdir(), "routes-rust-toolchain-")));
const wt = join(root, "wt");
const bin = join(root, "bin");
const project = { cwd: wt } as ProjectState;
const ctx = {
  findProjectForPath: (path: string) =>
    path === wt || path.startsWith(`${wt}/`) ? project : undefined,
} as RouteContext;

const previousEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

afterAll(async () => {
  Object.assign(process.env, previousEnv);
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

async function writeExecutable(filePath: string, script: string): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, script);
  await chmod(filePath, 0o755);
}

function toolchainDir(name: string): string {
  return join(root, "toolchains", name);
}

async function makeToolchain(name: string, version: string): Promise<void> {
  await writeExecutable(
    join(toolchainDir(name), "bin", "rustc"),
    `#!/bin/sh\necho "rustc ${version}"\n`,
  );
}

/** A rustup whose default is stable, with stable and 1.90.0 installed. */
async function makeRustup(): Promise<void> {
  await rm(bin, { recursive: true, force: true });
  await writeExecutable(
    join(bin, "rustup"),
    `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "rustup 1.29.2 (abc)" ;;
  "toolchain list") echo "${STABLE} (default) ${toolchainDir(STABLE)}"; echo "${PINNED} ${toolchainDir(PINNED)}" ;;
  "show active-toolchain")
    if [ -n "$RUSTUP_TOOLCHAIN" ]; then echo "$RUSTUP_TOOLCHAIN (overridden by environment variable RUSTUP_TOOLCHAIN)"; else echo "${STABLE} (default)"; fi ;;
  "which rustc") echo "${root}/toolchains/\${RUSTUP_TOOLCHAIN:-${STABLE}}/bin/rustc" ;;
esac
`,
  );
  await symlink("rustup", join(bin, "rustc"));
}

function setChoice(toolchain: unknown): Promise<Response> {
  return handleRequest(
    new Request("http://x/api/rust-toolchain/choice", {
      method: "POST",
      body: JSON.stringify({ worktreePath: wt, toolchain }),
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
  await makeToolchain(STABLE, "1.99.1");
  await makeToolchain(PINNED, "1.90.0");
  await makeRustup();
  Object.assign(process.env, { PATH: `${bin}:${previousEnv.PATH}`, HOME: join(root, "home") });
});

afterEach(async () => {
  await setChoice(null);
});

describe("Rust toolchain routes", () => {
  test("stores a chosen toolchain, reports it, and clears it", async () => {
    const res = await setChoice(PINNED);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RustToolchainResponse;
    expect(body.chosen).toBe(PINNED);
    expect(body.toolchain).toMatchObject({
      status: "active",
      source: "chosen",
      name: PINNED,
      version: "1.90.0",
    });
    expect(getRustChoice(wt)).toBe(PINNED);

    const choices = await get<RustToolchainCandidatesResponse>("/api/rust-toolchain/candidates");
    expect(choices.chosen).toBe(PINNED);
    expect(choices.automatic).toMatchObject({ source: "default", name: STABLE });
    expect(choices.candidates).toEqual([
      { name: STABLE, path: toolchainDir(STABLE), version: "1.99.1" },
      { name: PINNED, path: toolchainDir(PINNED), version: "1.90.0" },
    ]);

    expect((await setChoice(null)).status).toBe(200);
    const cleared = await get<RustToolchainResponse>("/api/rust-toolchain");
    expect(cleared.chosen).toBeNull();
    expect(cleared.toolchain).toMatchObject({ source: "default", name: STABLE });
  });

  test("rejects what is not an installed toolchain", async () => {
    const reject = async (toolchain: unknown, message: string) => {
      const res = await setChoice(toolchain);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    };
    await reject(42, "toolchain must be a string or null");
    await reject("1.70.0-aarch64-apple-darwin", "not an installed Rust toolchain");
    await reject("/some/path", "not an installed Rust toolchain");
    expect(getRustChoice(wt)).toBeNull();
  });

  test("refuses a path that is not a worktree of the project", async () => {
    const res = await handleRequest(
      new Request("http://x/api/rust-toolchain/choice", {
        method: "POST",
        body: JSON.stringify({ worktreePath: join(wt, "sub"), toolchain: null }),
      }),
      ctx,
    );
    expect(res.status).toBe(400);

    const missing = await handleRequest(new Request("http://x/api/rust-toolchain"), ctx);
    expect(missing.status).toBe(400);
  });
});
