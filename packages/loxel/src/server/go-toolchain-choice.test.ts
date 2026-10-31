import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { GoEnv } from "@/api/go-env-model";
import { repeatUntil } from "@/test/repeat-until";

import type { EnvChange } from "./toolchain-env-contributor";

// Choices live in the store database; keep the tests' state out of the real one.
const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "loxel-go-choice-")));
process.env.LOXEL_STATE_DIR = join(stateRoot, "state");
const { cachedToolchainDirName, cachedToolchainVersion, getGoEnv, goSpawnEnv, subscribeGoEnv } =
  await import("./go-env");
const { goFormatterWith } = await import("./go-formatter");
const { listGoToolchains, normalizeGoChoice } = await import("./go-toolchain-candidates");
const { goToolchainEnv } = await import("./go-toolchain-env");
const { goToolchainStatus } = await import("./go-toolchain-status");
const { getGoChoice, setGoChoice } = await import("./go-toolchain-store");

const PLATFORM = "testos-testarch";
const roots: string[] = [];
const cleanups: (() => void)[] = [];
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalGoroot = process.env.GOROOT;
const GIT = Bun.which("git");

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.env.PATH = originalPath;
  process.env.HOME = originalHome;
  process.env.GOROOT = originalGoroot;
  if (originalGoroot === undefined) delete process.env.GOROOT;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

interface FakeGo {
  version: string;
  goroot: string;
  modcache: string;
  log: string;
}

/**
 * Stands in for `go`, and logs each run with its cwd, arguments and environment. Reports the GOROOT
 * of the environment when one is set, as `go` does.
 */
async function installFakeGo(file: string, { version, goroot, modcache, log }: FakeGo) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(
    file,
    `#!/bin/sh
echo "${file}|$PWD|$*|GOROOT=$GOROOT|$GOTOOLCHAIN" >> "${log}"
if [ "$1" = version ]; then echo "go version go${version} testos/testarch"; exit 0; fi
echo "{\\"GOVERSION\\":\\"go${version}\\",\\"GOROOT\\":\\"\${GOROOT:-${goroot}}\\",\\"GOPATH\\":\\"/gopath\\",\\"GOMODCACHE\\":\\"${modcache}\\",\\"GOHOSTOS\\":\\"testos\\",\\"GOHOSTARCH\\":\\"testarch\\"}"
`,
  );
  await chmod(file, 0o755);
}

async function setup(goVersion = "1.20.0") {
  const wt = await makeDir("go-wt-");
  const installed = await makeDir("go-installed-");
  const modcache = await makeDir("go-modcache-");
  const log = join(await makeDir("go-log-"), "calls");
  await writeFile(log, "");
  const home = await makeDir("go-home-");
  process.env.HOME = home;
  const gitDir = await makeDir("go-git-");
  await symlink(GIT ?? "git", join(gitDir, "git"));
  const bin = join(installed, "bin");
  process.env.PATH = [bin, gitDir].join(delimiter);
  delete process.env.GOROOT;
  await installFakeGo(join(bin, "go"), { version: goVersion, goroot: installed, modcache, log });

  const cacheToolchain = async (version: string, name?: string) => {
    const dir = join(modcache, "golang.org", name ?? `toolchain@v0.0.1-go${version}.${PLATFORM}`);
    await installFakeGo(join(dir, "bin", "go"), { version, goroot: dir, modcache, log });
    return dir;
  };
  const installGo = async (version: string, root: string) => {
    await installFakeGo(join(root, "bin", "go"), { version, goroot: root, modcache, log });
    return join(root, "bin", "go");
  };
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
  cleanups.push(() => setGoChoice(wt, null));
  return { wt, home, bin, gitDir, installed, modcache, log, calls, cacheToolchain, installGo };
}

/** Calls `read` after each update of `wt` until it returns a value. */
function untilUpdate<T>(wt: string, read: (env: GoEnv | null) => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    cleanups.push(
      subscribeGoEnv(wt, ({ env }) => {
        const value = read(env);
        if (value !== undefined) resolve(value);
      }),
    );
  });
}

describe("a toolchain in the module cache", () => {
  test("is used when go.mod needs newer than the Go on the PATH", async () => {
    const { wt, cacheToolchain } = await setup();
    const dir = await cacheToolchain("1.26.3");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    const env = await getGoEnv(wt);
    expect(env).toMatchObject({
      binary: join(dir, "bin", "go"),
      source: "module-cache",
      version: "1.26.3",
      goroot: dir,
      newerGoNeeded: null,
    });
    const spawnEnv = goSpawnEnv(wt, env);
    expect(spawnEnv.PATH?.split(delimiter)[0]).toBe(join(dir, "bin"));
    expect(spawnEnv.GOROOT).toBe(dir);
    expect(spawnEnv.GOTOOLCHAIN).toBe("local");
  });

  test("keeps the warning, and the Go on the PATH, when it is absent", async () => {
    const { wt, bin } = await setup();
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({
      binary: join(bin, "go"),
      source: "path",
      version: "1.20.0",
      newerGoNeeded: { file: "go.mod", version: "1.26.3" },
    });
  });

  test("serves a language version with its first release, as go does", async () => {
    const { wt, cacheToolchain } = await setup();
    await cacheToolchain("1.26.0");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26\n");
    expect(await getGoEnv(wt)).toMatchObject({ source: "module-cache", version: "1.26.0" });
  });

  test("serves a newer toolchain line, or else the go line it can still load with", async () => {
    const { wt, cacheToolchain } = await setup();
    await cacheToolchain("1.26.0");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.0\ntoolchain go1.26.5\n");
    expect(await getGoEnv(wt)).toMatchObject({
      version: "1.26.0",
      newerGoNeeded: null,
      newerToolchainSuggested: { file: "go.mod", version: "1.26.5" },
    });
    await cacheToolchain("1.26.5");
    expect(await getGoEnv(wt)).toMatchObject({ version: "1.26.5", newerToolchainSuggested: null });
  });

  test("runs with its own GOROOT, whatever the login shell exports", async () => {
    const { wt, cacheToolchain, calls } = await setup();
    process.env.GOROOT = "/exported/goroot";
    const dir = await cacheToolchain("1.26.3");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({ goroot: dir });
    const fromCache = (await calls()).filter((call) => call.startsWith(join(dir, "bin", "go")));
    expect(fromCache.length).toBeGreaterThan(0);
    for (const call of fromCache) expect(call).toContain("|GOROOT=|local");
  });

  test.each([
    ["for another platform", (v: string) => `toolchain@v0.0.1-go${v}.otheros-otherarch`],
    ["of another name", (v: string) => `toolchain@v0.0.2-go${v}.${PLATFORM}`],
  ])("is not used when it is %s", async (_, name) => {
    const { wt, cacheToolchain } = await setup();
    await cacheToolchain("1.26.3", name("1.26.3"));
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({ source: "path", version: "1.20.0" });
  });

  test("is not used before go has made it executable", async () => {
    const { wt, cacheToolchain } = await setup();
    const dir = await cacheToolchain("1.26.3");
    await chmod(join(dir, "bin", "go"), 0o444);
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({ source: "path", version: "1.20.0" });
  });

  test("is not used when it reports another version", async () => {
    const { wt, cacheToolchain } = await setup();
    await cacheToolchain("1.25.0", `toolchain@v0.0.1-go1.26.3.${PLATFORM}`);
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({ source: "path", version: "1.20.0" });
  });

  test("is not used when its directory or binary lead out of the cache", async () => {
    const { wt, modcache, log, calls } = await setup();
    const outside = await makeDir("go-outside-");
    const outsideGo = join(outside, "bin", "go");
    await installFakeGo(outsideGo, { version: "1.26.3", goroot: outside, modcache, log });
    await mkdir(join(modcache, "golang.org"), { recursive: true });
    const name = `toolchain@v0.0.1-go1.26.3.${PLATFORM}`;
    await symlink(outside, join(modcache, "golang.org", name));
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({ source: "path" });

    await rm(join(modcache, "golang.org", name));
    await mkdir(join(modcache, "golang.org", name, "bin"), { recursive: true });
    await symlink(outsideGo, join(modcache, "golang.org", name, "bin", "go"));
    expect(await getGoEnv(wt)).toMatchObject({ source: "path" });
    expect((await calls()).some((call) => call.startsWith(outsideGo))).toBe(false);
  });

  test("is not used from a cache in the worktree", async () => {
    const { wt, bin, log } = await setup();
    const modcache = join(wt, "cache");
    await installFakeGo(join(bin, "go"), { version: "1.20.0", goroot: bin, modcache, log });
    const dir = join(modcache, "golang.org", `toolchain@v0.0.1-go1.26.3.${PLATFORM}`);
    await installFakeGo(join(dir, "bin", "go"), { version: "1.26.3", goroot: dir, modcache, log });
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await getGoEnv(wt)).toMatchObject({ source: "path" });
  });

  test.each([
    "go 1.99.0/../../../../planted\n",
    "go ../../../planted\n",
    "go 1.99.0/\n",
    "go 1.99..0\n",
    "go 1.99.0.linux-amd64\n",
    "go 1.99.0-x\n",
    "go 1.99.0\\..\\planted\n",
    "go 1.99rc1/../x\n",
    "go 99999999999.1\n",
    "go 1.20.0\ntoolchain go1.99.0/../../../planted\n",
    "go 1.20.0\ntoolchain go../../planted\n",
  ])("does not follow the hostile go.mod line %j", async (line) => {
    const { wt, modcache, log, calls, bin } = await setup();
    const planted = join(modcache, "planted");
    await installFakeGo(join(planted, "bin", "go"), {
      version: "1.99.0",
      goroot: planted,
      modcache,
      log,
    });
    await writeFile(join(wt, "go.mod"), `module x\n\n${line}`);
    expect(await getGoEnv(wt)).toMatchObject({
      binary: join(bin, "go"),
      source: "path",
      newerGoNeeded: null,
      newerToolchainSuggested: null,
    });
    expect((await calls()).some((call) => call.includes(planted))).toBe(false);
  });

  test("is picked up once go has made it executable", async () => {
    const { wt, cacheToolchain } = await setup();
    const dir = await cacheToolchain("1.26.3");
    await chmod(join(dir, "bin", "go"), 0o444);
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    const found = untilUpdate(wt, (env) => (env?.source === "module-cache" ? env : undefined));
    await getGoEnv(wt);
    const env = await repeatUntil(found, async () => {
      await chmod(join(dir, "bin", "go"), 0o444);
      await chmod(join(dir, "bin", "go"), 0o755);
    });
    expect(env.version).toBe("1.26.3");
  }, 60_000);

  test("restarts what follows the toolchain when a terminal downloads it", async () => {
    const { wt, cacheToolchain } = await setup();
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    const found = untilUpdate(wt, (env) => (env?.source === "module-cache" ? env : undefined));
    await getGoEnv(wt);
    // Each resolution rewatches, so keep writing until a watch armed in time sees the new directory.
    const env = await repeatUntil(found, async () => {
      await cacheToolchain("1.26.3");
    });
    expect(env.version).toBe("1.26.3");
  }, 60_000);
});

describe("cachedToolchainDirName", () => {
  test.each([
    "../x",
    "1.26/../../x",
    "1.26.3/",
    "1.26.3\\x",
    "1..3",
    "1.26.3.x",
    "1.26.3-custom",
    " 1.26",
    "1.26\n",
    "",
  ])("refuses %j", (version) => {
    expect(cachedToolchainDirName(version, PLATFORM)).toBeNull();
  });

  test("refuses a platform with separators", () => {
    expect(cachedToolchainDirName("1.26.3", "../x-y")).toBeNull();
    expect(cachedToolchainDirName("1.26.3", "x/y-z")).toBeNull();
  });

  test("names a release, a pre-release and a language version's first release", () => {
    const name = (version: string) => cachedToolchainDirName(version, "darwin-arm64");
    expect(name("1.26.3")).toBe("toolchain@v0.0.1-go1.26.3.darwin-arm64");
    expect(name("1.26rc1")).toBe("toolchain@v0.0.1-go1.26rc1.darwin-arm64");
    expect(name("1.26")).toBe("toolchain@v0.0.1-go1.26.0.darwin-arm64");
  });

  test("reads back only names of its own shape", () => {
    expect(cachedToolchainVersion("toolchain@v0.0.1-go1.26.3.darwin-arm64", "darwin-arm64")).toBe(
      "1.26.3",
    );
    for (const name of [
      "toolchain@v0.0.1-go1.26.darwin-arm64",
      "toolchain@v0.0.1-go1.26.3.linux-amd64",
      "toolchain@v0.0.1-go../x.darwin-arm64",
      "x",
    ]) {
      expect(cachedToolchainVersion(name, "darwin-arm64")).toBeNull();
    }
  });
});

describe("a chosen Go", () => {
  test("takes precedence, with its GOROOT, also over a toolchain in the module cache", async () => {
    const { wt, installGo, cacheToolchain } = await setup();
    await cacheToolchain("1.26.3");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    const root = await makeDir("go-chosen-");
    const go = await installGo("1.24.1", root);
    setGoChoice(wt, go);
    const env = await getGoEnv(wt);
    expect(env).toMatchObject({
      binary: go,
      source: "chosen",
      version: "1.24.1",
      goroot: root,
      newerGoNeeded: { version: "1.26.3" },
    });
    const spawnEnv = goSpawnEnv(wt, env);
    expect(spawnEnv.PATH?.split(delimiter)[0]).toBe(join(root, "bin"));
    expect(spawnEnv.GOROOT).toBe(root);
  });

  test("is followed by a subscribed worktree as soon as it is set or cleared", async () => {
    const { wt, installGo } = await setup();
    cleanups.push(subscribeGoEnv(wt, () => undefined));
    expect(await getGoEnv(wt)).toMatchObject({ source: "path" });
    const go = await installGo("1.24.1", await makeDir("go-chosen-"));
    setGoChoice(wt, go);
    expect(await getGoEnv(wt)).toMatchObject({ source: "chosen", version: "1.24.1" });
    setGoChoice(wt, null);
    expect(await getGoEnv(wt)).toMatchObject({ source: "path", version: "1.20.0" });
  });

  test("goes back to detection when it is gone, keeping the choice for the warning", async () => {
    const { wt, installGo } = await setup();
    const root = await makeDir("go-chosen-");
    const go = await installGo("1.24.1", root);
    setGoChoice(wt, go);
    expect(await getGoEnv(wt)).toMatchObject({ source: "chosen" });
    await rm(go);
    expect(await getGoEnv(wt)).toMatchObject({ source: "path", version: "1.20.0" });
    expect(getGoChoice(wt)).toBe(go);
  });

  test("is noticed when it disappears while subscribed", async () => {
    const { wt, installGo } = await setup();
    const root = await makeDir("go-chosen-");
    const go = await installGo("1.24.1", root);
    setGoChoice(wt, go);
    const fellBack = untilUpdate(wt, (env) => (env?.source === "path" ? env : undefined));
    expect(await getGoEnv(wt)).toMatchObject({ source: "chosen" });
    const env = await repeatUntil(fellBack, async () => {
      await installGo("1.24.1", root);
      await rm(go);
    });
    expect(env.version).toBe("1.20.0");
  }, 60_000);

  test("does not run when stored for a path in the worktree", async () => {
    const { wt, log, modcache, calls } = await setup();
    const go = join(wt, "tools", "bin", "go");
    await installFakeGo(go, { version: "1.24.1", goroot: join(wt, "tools"), modcache, log });
    setGoChoice(wt, go);
    expect(await getGoEnv(wt)).toMatchObject({ source: "path" });
    expect((await calls()).some((call) => call.startsWith(go))).toBe(false);
  });

  test("does not count when the GOROOT it reports is in the worktree", async () => {
    const { wt, modcache, log } = await setup();
    const root = await makeDir("go-chosen-");
    const go = join(root, "bin", "go");
    const inWorktree = join(wt, "goroot");
    await installFakeGo(go, { version: "1.24.1", goroot: inWorktree, modcache, log });
    await installFakeGo(join(inWorktree, "bin", "go"), {
      version: "1.24.1",
      goroot: inWorktree,
      modcache,
      log,
    });
    setGoChoice(wt, go);
    expect(await getGoEnv(wt)).toMatchObject({ source: "path" });
  });
});

describe("normalizeGoChoice", () => {
  test("takes a binary, a GOROOT and a path under the home directory", async () => {
    const { wt, home, installGo } = await setup();
    const go = await installGo("1.24.1", join(home, "sdk", "go1.24.1"));
    expect(await normalizeGoChoice(wt, go)).toBe(go);
    expect(await normalizeGoChoice(wt, join(home, "sdk", "go1.24.1"))).toBe(go);
    expect(await normalizeGoChoice(wt, "~/sdk/go1.24.1", home)).toBe(go);
    expect(await normalizeGoChoice(wt, "  ~/sdk/go1.24.1/bin/go ", home)).toBe(go);
  });

  test("runs the check from the home directory, with Loxel's Go environment", async () => {
    const { wt, home, installGo, calls } = await setup();
    const go = await installGo("1.24.1", join(home, "sdk", "go1.24.1"));
    await normalizeGoChoice(wt, go, home);
    expect(await calls()).toEqual([`${go}|${homedir()}|version|GOROOT=|local`]);
  });

  test("refuses a relative or missing path", async () => {
    const { wt } = await setup();
    expect(normalizeGoChoice(wt, "go")).rejects.toThrow("absolute path");
    expect(normalizeGoChoice(wt, "./bin/go")).rejects.toThrow("absolute path");
    expect(normalizeGoChoice(wt, "/does/not/exist")).rejects.toThrow("No executable Go");
  });

  test("refuses what does not answer like a Go", async () => {
    const { wt } = await setup();
    const file = join(await makeDir("go-other-"), "go");
    for (const answer of ["echo hello", "echo go version", "exit 1"]) {
      await writeFile(file, `#!/bin/sh\n${answer}\n`);
      await chmod(file, 0o755);
      expect(normalizeGoChoice(wt, file)).rejects.toThrow("did not report a Go version");
    }
  });

  test("refuses a binary in the worktree, directly or by symlink, without running it", async () => {
    const { wt, modcache, log, calls } = await setup();
    const go = join(wt, "bin", "go");
    await installFakeGo(go, { version: "1.24.1", goroot: wt, modcache, log });
    expect(normalizeGoChoice(wt, go)).rejects.toThrow("in the worktree");
    expect(normalizeGoChoice(wt, wt)).rejects.toThrow("in the worktree");
    const link = join(await makeDir("go-link-"), "go");
    await symlink(go, link);
    expect(normalizeGoChoice(wt, link)).rejects.toThrow("in the worktree");
    expect((await calls()).some((call) => call.startsWith(go))).toBe(false);
  });

  test("takes a development build's or experiment's version line", async () => {
    const { wt } = await setup();
    const file = join(await makeDir("go-other-"), "go");
    for (const line of [
      "go version devel go1.28-abcdef Thu Jan 1 00:00:00 2026 +0000 darwin/arm64",
      "go version go1.27.3 X:rangefunc darwin/arm64",
    ]) {
      await writeFile(file, `#!/bin/sh\necho "${line}"\n`);
      await chmod(file, 0o755);
      expect(await normalizeGoChoice(wt, file)).toBe(file);
    }
  });

  test("refuses a link in the worktree to a Go elsewhere, without running it", async () => {
    const { wt, modcache, log, calls } = await setup();
    const elsewhere = join(await makeDir("go-elsewhere-"), "bin", "go");
    await installFakeGo(elsewhere, { version: "1.24.1", goroot: "/x", modcache, log });
    await mkdir(join(wt, "tools"));
    await symlink(elsewhere, join(wt, "tools", "go"));
    expect(normalizeGoChoice(wt, join(wt, "tools", "go"))).rejects.toThrow("in the worktree");
    expect(await calls()).toEqual([]);
  });

  test("never runs a link to a shim in the worktree", async () => {
    const { wt, home, installGo, modcache, log, calls } = await setup();
    const root = join(home, "installs", "go", "1.24.1");
    const go = await installGo("1.24.1", root);
    const shim = join(home, "shims", "go");
    await installFakeGo(shim, { version: "1.24.1", goroot: root, modcache, log });
    const link = join(await makeDir("go-link-"), "go");
    await symlink(shim, link);
    expect(await normalizeGoChoice(wt, link)).toBe(go);
    setGoChoice(wt, link);
    await getGoEnv(wt);
    const shimCalls = (await calls()).filter((call) => call.startsWith(shim));
    for (const call of shimCalls) expect(call.split("|")[1]).toBe(homedir());
  });

  test("stores the Go behind a shim, which runs only from the home directory", async () => {
    const { wt, home, installGo, modcache, log, calls } = await setup();
    const root = join(home, "installs", "go", "1.24.1");
    const go = await installGo("1.24.1", root);
    const shim = join(home, "shims", "go");
    await installFakeGo(shim, { version: "1.24.1", goroot: root, modcache, log });
    expect(await normalizeGoChoice(wt, shim)).toBe(go);
    const shimCalls = (await calls()).filter((call) => call.startsWith(shim));
    expect(shimCalls.length).toBeGreaterThan(0);
    for (const call of shimCalls) expect(call.split("|")[1]).toBe(homedir());
  });
});

describe("listGoToolchains", () => {
  test("lists what is found, newest first, and is silent about what is absent", async () => {
    const { wt, home, bin, installGo, cacheToolchain } = await setup();
    const sdk = await installGo("1.22.1", join(home, "sdk", "go1.22.1"));
    const mise = await installGo("1.23.1", join(home, ".local/share/mise/installs/go/1.23.1"));
    const asdf = await installGo("1.24.1", join(home, ".asdf/installs/golang/1.24.1/go"));
    const cached = await cacheToolchain("1.26.3");
    await cacheToolchain("1.25.0", "toolchain@v0.0.1-go1.25.0.otheros-otherarch");
    const list = await listGoToolchains(wt, await getGoEnv(wt), home);
    const ofTests = list.filter(
      ({ path }) => path.startsWith(home) || path.startsWith(cached) || path === join(bin, "go"),
    );
    expect(ofTests).toEqual([
      { path: join(cached, "bin", "go"), version: "1.26.3", fromModuleCache: true },
      { path: asdf, version: "1.24.1", fromModuleCache: false },
      { path: mise, version: "1.23.1", fromModuleCache: false },
      { path: sdk, version: "1.22.1", fromModuleCache: false },
      { path: join(bin, "go"), version: "1.20.0", fromModuleCache: false },
    ]);
  });

  test("lists a symlinked install once, and nothing that does not answer", async () => {
    const { wt, home, installGo } = await setup();
    await installGo("1.22.1", join(home, "sdk", "go1.22.1"));
    await symlink(join(home, "sdk", "go1.22.1"), join(home, "sdk", "go1.22"));
    const broken = join(home, "sdk", "gobroken", "bin", "go");
    await mkdir(join(broken, ".."), { recursive: true });
    await writeFile(broken, "#!/bin/sh\nexit 1\n");
    await chmod(broken, 0o755);
    const list = await listGoToolchains(wt, null, home);
    const inSdk = list.filter(({ path }) => path.startsWith(join(home, "sdk")));
    expect(inSdk).toHaveLength(1);
    expect(inSdk[0]?.version).toBe("1.22.1");
  });
});

describe("listGoToolchains and the trust rule", () => {
  test("does not run a shim on the PATH that a repository tracks", async () => {
    const { wt, bin, gitDir, modcache, log, calls } = await setup();
    const repo = await makeDir("go-dotfiles-");
    const shim = join(repo, "shims", "go");
    await installFakeGo(shim, { version: "1.24.1", goroot: "/x", modcache, log });
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, PATH: gitDir } });
    git("init", "-q");
    git("add", ".");
    Bun.spawnSync(["git", "init", "-q", wt], { env: { ...process.env, PATH: gitDir } });
    process.env.PATH = [join(repo, "shims"), bin, gitDir].join(delimiter);
    await listGoToolchains(wt, null, await makeDir("go-home-"));
    expect((await calls()).some((call) => call.startsWith(shim))).toBe(false);
  });
});

describe("goToolchainEnv", () => {
  test("changes nothing and runs nothing without a choice, cached toolchains included", async () => {
    const { wt, cacheToolchain, calls } = await setup();
    await cacheToolchain("1.26.3");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    expect(await goToolchainEnv.resolveForTerminal(wt)).toBeNull();
    expect(await goToolchainEnv.resolveForAgent(wt)).toBeNull();
    expect(await calls()).toEqual([]);
  });

  test("puts a chosen Go's bin first on PATH and nothing else", async () => {
    const { wt, installGo } = await setup();
    const root = await makeDir("go-chosen-");
    setGoChoice(wt, await installGo("1.24.1", root));
    const change = await goToolchainEnv.resolveForTerminal(wt);
    const env = { PATH: `/usr/bin${delimiter}${join(root, "bin")}`, HOME: "/h" };
    await change?.(env, "/bin/zsh");
    expect(env).toEqual({ PATH: `${join(root, "bin")}${delimiter}/usr/bin`, HOME: "/h" });

    const agentChange = await goToolchainEnv.resolveForAgent(wt);
    const agentEnv = { PATH: "/usr/bin" };
    agentChange?.(agentEnv);
    expect(agentEnv).toEqual({ PATH: `${join(root, "bin")}${delimiter}/usr/bin` });
  });

  test("changes nothing when the chosen Go is gone", async () => {
    const { wt, installGo } = await setup();
    const go = await installGo("1.24.1", await makeDir("go-chosen-"));
    setGoChoice(wt, go);
    await rm(go);
    expect(await goToolchainEnv.resolveForTerminal(wt)).toBeNull();
  });

  test("tells the agent when the choice changes", async () => {
    const { wt, installGo } = await setup();
    const root = await makeDir("go-chosen-");
    const resolved = new Promise<() => Promise<EnvChange | null>>((done) => {
      cleanups.push(goToolchainEnv.subscribeForAgent(wt, done));
    });
    setGoChoice(wt, await installGo("1.24.1", root));
    await getGoEnv(wt);
    const change = await (await resolved)();
    const env = { PATH: "/usr/bin" };
    change?.(env);
    expect(env.PATH.split(delimiter)[0]).toBe(join(root, "bin"));
  });
});

describe("the routes", () => {
  const choice = goToolchainStatus.routes.POST["/api/go-env/choice"];
  const candidates = goToolchainStatus.routes.GET["/api/go-env/candidates"];

  test("store a valid choice, report it, and clear it", async () => {
    const { wt, installGo } = await setup();
    const root = await makeDir("go-chosen-");
    const go = await installGo("1.24.1", root);
    const set = await choice?.(wt, { goPath: root });
    expect(await set?.json()).toMatchObject({ env: { binary: go }, chosen: go });
    const listed = await (await candidates?.(wt))?.json();
    expect(listed).toMatchObject({ automatic: { source: "path" }, chosen: go });
    const cleared = await choice?.(wt, { goPath: null });
    expect(await cleared?.json()).toMatchObject({ env: { source: "path" }, chosen: null });
    expect(getGoChoice(wt)).toBeNull();
  });

  test("refuse a bad path or type, keeping the choice as it was", async () => {
    const { wt } = await setup();
    expect((await choice?.(wt, { goPath: 3 }))?.status).toBe(400);
    const missing = await choice?.(wt, { goPath: "/does/not/exist" });
    expect(missing?.status).toBe(400);
    expect(await missing?.text()).toContain("No executable Go");
    expect(getGoChoice(wt)).toBeNull();
  });
});

describe("the Go formatter", () => {
  test("runs from a chosen Go's GOROOT, which goes first on its PATH", async () => {
    const { wt, installGo } = await setup();
    const root = await makeDir("go-chosen-");
    const go = await installGo("1.24.1", root);
    await writeFile(join(root, "bin", "gofmt"), "#!/bin/sh\n");
    await chmod(join(root, "bin", "gofmt"), 0o755);
    setGoChoice(wt, go);
    const options = await goFormatterWith(60_000).spawnOptions?.("gofmt", wt, wt);
    expect(options?.env?.PATH?.split(delimiter)[0]).toBe(join(root, "bin"));
    expect(options?.env?.GOROOT).toBe(root);
    expect(options?.env?.GOTOOLCHAIN).toBe("local");
  });

  test("runs from a cached toolchain the project asks for", async () => {
    const { wt, cacheToolchain } = await setup();
    const dir = await cacheToolchain("1.26.3");
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.26.3\n");
    const options = await goFormatterWith(60_000).spawnOptions?.("gofmt", wt, wt);
    expect(options?.env?.PATH?.split(delimiter)[0]).toBe(join(dir, "bin"));
  });
});
