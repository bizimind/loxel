import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Trust lives in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "csharp-env-trust-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const {
  dotnetGlobalToolsDir,
  isVersionManagerShim,
  prepareDotnet,
  readDotnetToolManifests,
  resolveGlobalDotnetTool,
  toolClaimsCommand,
} = await import("./csharp-env");
const { setRepoTrusted } = await import("./repo-trust");
const { runGit } = await import("./shipped-by-repo");

// Each test spawns git; how fast is not what these test.
setDefaultTimeout(60_000);

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function write(file: string, content = ""): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function writeExecutable(file: string): Promise<string> {
  await write(file, "#!/bin/sh\n");
  await chmod(file, 0o755);
  return file;
}

async function makeRepo(): Promise<string> {
  const wt = await makeDir("csharp-trust-wt-");
  const proc = Bun.spawn(["git", "-C", wt, "init", "-q"], { stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error("git init failed");
  return wt;
}

/** `dir` first on the `PATH`, and `git`, which the checks run, alone in a directory of its own. */
async function pathWith(dir: string): Promise<Record<string, string>> {
  const gitDir = await makeDir("csharp-trust-git-");
  await symlink(Bun.which("git", { PATH: originalPath }) ?? "git", join(gitDir, "git"));
  return { PATH: [dir, gitDir].join(delimiter) };
}

describe.skipIf(process.platform === "win32")("prepareDotnet and trust", () => {
  test("a version manager's shim runs only in a trusted repository", async () => {
    const shims = join(await makeDir("csharp-trust-tool-"), "shims");
    const dotnet = await writeExecutable(join(shims, "dotnet"));
    const env = await pathWith(shims);
    const wt = await makeRepo();
    expect(await isVersionManagerShim(dotnet)).toBe(true);
    expect(await prepareDotnet(wt, { env })).toBeNull();
    setRepoTrusted(wt, true);
    expect((await prepareDotnet(wt, { env }))?.dotnetPath).toBe(dotnet);
  });

  test("a symlink to a shim counts as one", async () => {
    const tool = await makeDir("csharp-trust-tool-");
    const shim = await writeExecutable(join(tool, "shims", "dotnet"));
    const link = join(tool, "dotnet");
    await symlink(shim, link);
    expect(await isVersionManagerShim(link)).toBe(true);
  });

  test("an SDK the repository tracks is refused until the repository is trusted", async () => {
    const bin = await makeDir("csharp-trust-tool-");
    const dotnet = await writeExecutable(join(bin, "dotnet"));
    const env = await pathWith(bin);
    const wt = await makeRepo();
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".sdk"]}}');
    await write(join(wt, ".sdk", "sdk", "1.0.0", "file"));
    for (const args of [["add", "-A"]]) {
      const proc = Bun.spawn(["git", "-C", wt, ...args], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
    }
    expect(await prepareDotnet(wt, { env })).toBeNull();
    setRepoTrusted(wt, true);
    expect((await prepareDotnet(wt, { env }))?.dotnetPath).toBe(dotnet);
  });
});

describe.skipIf(process.platform === "win32")("resolveGlobalDotnetTool", () => {
  test("looks on PATH first, then in the global tools directory", async () => {
    const home = await makeDir("csharp-trust-home-");
    const bin = await makeDir("csharp-trust-tool-");
    const wt = await makeRepo();
    const env = { ...(await pathWith(bin)), HOME: home };
    expect(await resolveGlobalDotnetTool(wt, "some-tool", { env })).toBeNull();
    const global = await writeExecutable(join(dotnetGlobalToolsDir(env), "some-tool"));
    expect(await resolveGlobalDotnetTool(wt, "some-tool", { env })).toBe(global);
    const onPath = await writeExecutable(join(bin, "some-tool"));
    expect(await resolveGlobalDotnetTool(wt, "some-tool", { env })).toBe(onPath);
  });
});

describe("tool manifests", () => {
  test("reads both locations with dotnet's leniency, and skips what is not a file", async () => {
    const dir = await makeDir("csharp-trust-manifest-");
    await write(
      join(dir, ".config", "dotnet-tools.json"),
      '{ // a comment\n "tools": { "x": { "commands": ["x-cmd"] }, }, }',
    );
    await mkdir(join(dir, "dotnet-tools.json"));
    const [manifest, ...others] = readDotnetToolManifests(dir);
    expect(others).toEqual([]);
    const { tools } = manifest as { tools: { x: unknown } };
    expect(toolClaimsCommand(tools.x, "x-cmd")).toBe(true);
    expect(toolClaimsCommand(tools.x, "other")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("runGit", () => {
  test("does not run a repository's configured fsmonitor", async () => {
    const wt = await makeRepo();
    const marker = join(wt, "ran");
    const hook = await write(join(wt, "hook.sh"), `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(hook, 0o755);
    const config = Bun.spawn(["git", "-C", wt, "config", "core.fsmonitor", hook]);
    await config.exited;
    expect((await runGit(wt, ["status", "--porcelain"])).exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
