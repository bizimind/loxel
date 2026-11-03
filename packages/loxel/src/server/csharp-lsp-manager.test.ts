import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { ServerWebSocket } from "bun";

import { LSP_REPLACED_CLOSE_CODE, LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

// Trust lives in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "csharp-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { CSharpLspManager, CSHARP_LS_SETTINGS, MIN_CSHARP_LS_VERSION, withClientRegistrations } =
  await import("./csharp-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");
const { getCSharpLspState, subscribeCSharpStatus } = await import("./csharp-lsp-state");
const { setCSharpSolution } = await import("./csharp-solution-store");
const { projectsSolutionPath } = await import("./csharp-projects-solution");
type WtLspContext = import("./stdio-lsp-manager").WtLspContext;
type WtLspSession = import("./stdio-lsp-manager").WtLspSession;

// Each test spawns git and scripts many times; how fast is not what these test.
setDefaultTimeout(60_000);

const SHORT_MS = 5;
const roots: string[] = [];
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
let manager: InstanceType<typeof CSharpLspManager> | undefined;

/** Captures no login shell: the tests' `PATH` is all there is. */
class TestManager extends CSharpLspManager {
  constructor() {
    super(SHORT_MS, SHORT_MS, SHORT_MS);
  }
  protected override refreshToolchainEnv(): void {}
}

/** Counts decisions and ticks, which the test waits on. */
class CountingManager extends TestManager {
  started = 0;
  finished = 0;
  refreshes = 0;
  private readonly waiters: (() => void)[] = [];

  protected override async gate(context: WtLspContext) {
    this.started++;
    const gate = await super.gate(context);
    this.finished++;
    this.wake();
    return gate;
  }

  protected override refreshToolchainEnv(): void {
    this.refreshes++;
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async until(condition: () => boolean): Promise<void> {
    while (!condition()) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

/** With a deadline short enough to reach in a test. */
class StallingTestManager extends CSharpLspManager {
  constructor() {
    super(SHORT_MS, SHORT_MS, SHORT_MS, 200);
  }
  protected override refreshToolchainEnv(): void {}
}

afterEach(async () => {
  await manager?.destroy();
  manager = undefined;
  process.env.PATH = originalPath;
  process.env.HOME = originalHome;
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

async function writeExecutable(file: string, script: string): Promise<string> {
  await write(file, script);
  await chmod(file, 0o755);
  return file;
}

const PROJECT = '<Project Sdk="Microsoft.NET.Sdk"></Project>';

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** A repository with `obj` ignored, as `dotnet new gitignore` leaves it, and any `files`. */
async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const wt = await makeDir("csharp-wt-");
  await git(wt, "init", "-q");
  await write(join(wt, ".gitignore"), "obj/\nbin/\n");
  for (const [name, content] of Object.entries(files)) await write(join(wt, name), content);
  return wt;
}

/** Stands in for `dotnet`: a marker for every run, when one is asked for, and the given versions. */
function fakeDotnet(bin: string, sdks: string, runtime: string, marker?: string): Promise<string> {
  const dotnetRoot = bin;
  return writeExecutable(
    join(bin, "dotnet"),
    `#!/bin/sh
${marker ? `echo "$*" >> "${marker}"` : ""}
case "$1" in
  --list-runtimes) echo "Microsoft.NETCore.App ${runtime} [${dotnetRoot}/shared/Microsoft.NETCore.App]" ;;
  --list-sdks) echo "${sdks} [${dotnetRoot}/sdk]" ;;
  --version) [ -f global.json ] && exit 145; echo "${sdks}" ;;
  tool) [ -f "$HOME/.dotnet/toolResolverCache/1/csharp-ls" ] && echo "csharp-ls, 0.28.0.0" ;;
esac
`,
  );
}

// Stands in for csharp-ls: asks for its settings, then reports what it was started with.
const fakeCSharpLs = (version: string) => `#!${process.execPath}
if (process.argv[2] === "--version") {
  console.log("csharp-ls, ${version}.0");
  process.exit(0);
}
let buffer = "";
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer)[1]);
    if (buffer.length < end + 4 + length) return;
    const msg = JSON.parse(buffer.slice(end + 4, end + 4 + length));
    buffer = buffer.slice(end + 4 + length);
    if (msg.method === "test/startChild") {
      // In a process group of its own, as a build's children can be.
      const child = require("node:child_process").spawn("/bin/sleep", ["1000"], { detached: true, stdio: "ignore" });
      send({ jsonrpc: "2.0", method: "test/childStarted", params: { pid: child.pid } });
    } else if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          args: process.argv.slice(2),
          cwd: process.cwd(),
          dotnetRoot: process.env.DOTNET_ROOT,
          nodeReuse: process.env.MSBUILDDISABLENODEREUSE,
          nugetResolver: process.env.MSBUILDDISABLENUGETSDKRESOLVER,
          capabilities: {},
        },
      });
      send({ jsonrpc: "2.0", id: 900, method: "workspace/configuration", params: { items: [{ section: "csharp" }, { section: "other" }] } });
    } else if (msg.id === 900) {
      send({ jsonrpc: "2.0", method: "test/configuration", params: msg.result });
      const failed = process.cwd() + "/Broken.csproj";
      send({
        jsonrpc: "2.0",
        method: "window/logMessage",
        params: { type: 3, message: "csharp-ls: msbuildWorkspace.Diagnostics: [Failure] Msbuild failed when processing the file '" + failed + "' with message: No target." },
      });
    }
  }
});
`;

interface Toolchain {
  bin: string;
  /** Lines `dotnet` was run with. */
  dotnetRuns: string;
}

/** `dotnet` and csharp-ls on a `PATH` holding nothing else but `git`, with an empty `HOME`. */
async function installToolchain(
  options: { sdk?: string; runtime?: string; csharpLs?: string | null; dotnet?: boolean } = {},
): Promise<Toolchain> {
  const bin = await makeDir("csharp-bin-");
  const dotnetRuns = join(bin, "dotnet-runs");
  if (options.dotnet !== false) {
    await fakeDotnet(bin, options.sdk ?? "10.0.100", options.runtime ?? "10.0.0", dotnetRuns);
  }
  if (options.csharpLs !== null) {
    await writeExecutable(join(bin, "csharp-ls"), fakeCSharpLs(options.csharpLs ?? "0.28.0"));
  }
  const gitDir = await makeDir("csharp-git-");
  await symlink(Bun.which("git", { PATH: originalPath }) ?? "git", join(gitDir, "git"));
  process.env.HOME = await makeDir("csharp-home-");
  process.env.PATH = [bin, gitDir].join(delimiter);
  return { bin, dotnetRuns };
}

/** Stands in for the WebSocket and the Monaco client behind it. */
function fakeSocket() {
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let close: { code: number; reason: string } | undefined;
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const ws = {
    send: (data: string) => {
      frames.push(JSON.parse(data));
      wake();
      return data.length;
    },
    close: (code: number, reason: string) => {
      close ??= { code, reason };
      wake();
    },
  } as unknown as ServerWebSocket<unknown>;
  const until = async <T>(read: () => T | undefined): Promise<T> => {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  };
  const untilFrame = (match: (frame: Record<string, unknown>) => boolean) =>
    until(() => frames.find(match));
  return {
    ws,
    frames,
    untilClosed: () => until(() => close),
    untilFrame,
    /** The `initialize` result, which tells a hold (`serverInfo`) from a server. */
    untilInitialized: async () =>
      (await untilFrame((frame) => frame.id === 1)).result as Record<string, unknown>,
    untilMessage: async (text: string) => {
      const frame = await untilFrame(
        (candidate) =>
          candidate.method === "window/showMessage" &&
          (candidate.params as { message: string }).message.includes(text),
      );
      return (frame.params as { type: number; message: string }).message;
    },
    messages: () =>
      frames
        .filter((frame) => frame.method === "window/showMessage")
        .map((frame) => (frame.params as { message: string }).message),
  };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { capabilities: {} },
});
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} });

function connect(wt: string) {
  manager ??= new TestManager();
  const socket = fakeSocket();
  manager.createSession(socket.ws, wt);
  manager.handleMessage(socket.ws, INITIALIZE);
  manager.handleMessage(socket.ws, INITIALIZED);
  return socket;
}

const isHold = (result: Record<string, unknown>) => result.args === undefined;

/** A killed process lingers until its parent or init has collected it, which is why this waits. */
function isRunning(pid: number): boolean {
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    env: { PATH: "/bin:/usr/bin" },
  }).stdout.toString();
  return state.trim() !== "" && !state.startsWith("Z");
}

/** A repository that is trusted, with one project that `dotnet restore` has run for. */
async function makeRestoredRepo(files: Record<string, string> = {}): Promise<string> {
  const wt = await makeRepo({ "App.csproj": PROJECT, "obj/project.assets.json": "{}", ...files });
  setRepoTrusted(wt, true);
  return wt;
}

describe.skipIf(process.platform === "win32")("CSharpLspManager", () => {
  describe("gate", () => {
    test("an untrusted repository gets no process, no dotnet, and the restriction reported", async () => {
      const { dotnetRuns } = await installToolchain();
      const wt = await makeRepo({ "App.csproj": PROJECT, "obj/project.assets.json": "{}" });
      const socket = connect(wt);
      expect(isHold(await socket.untilInitialized())).toBe(true);
      expect(socket.messages()).toEqual([]);
      expect(getRepoTrustStatus(wt).restrictions).toHaveLength(1);
      expect(await Bun.file(dotnetRuns).exists()).toBe(false);
    });

    test("a trusted repository with no project stays quiet", async () => {
      await installToolchain();
      const wt = await makeRepo({ "Loose.cs": "class Loose {}" });
      setRepoTrusted(wt, true);
      const socket = connect(wt);
      expect(isHold(await socket.untilInitialized())).toBe(true);
      expect(socket.messages()).toEqual([]);
    });

    test("a restore opens the gate: the client is told to reconnect, and then gets a server", async () => {
      await installToolchain();
      const wt = await makeRepo({ "App.csproj": PROJECT });
      setRepoTrusted(wt, true);
      const held = connect(wt);
      expect(isHold(await held.untilInitialized())).toBe(true);
      await held.untilMessage("dotnet restore");
      await write(join(wt, "obj", "project.assets.json"), "{}");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "App.csproj")]);
      expect((await held.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
      manager?.destroySession(held.ws);

      const server = connect(wt);
      expect(isHold(await server.untilInitialized())).toBe(false);
    });

    test("trust opens the gate from a held connection", async () => {
      await installToolchain();
      const wt = await makeRepo({ "App.csproj": PROJECT, "obj/project.assets.json": "{}" });
      const held = connect(wt);
      expect(isHold(await held.untilInitialized())).toBe(true);
      setRepoTrusted(wt, true);
      expect((await held.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("csharp-ls installed while held opens the gate on a recheck", async () => {
      const { bin } = await installToolchain({ csharpLs: null });
      const wt = await makeRestoredRepo();
      const held = connect(wt);
      await held.untilMessage("dotnet tool install --global csharp-ls");
      await writeExecutable(join(bin, "csharp-ls"), fakeCSharpLs("0.28.0"));
      expect((await held.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("a newer connection replaces a held one", async () => {
      await installToolchain({ csharpLs: null });
      const wt = await makeRestoredRepo();
      const first = connect(wt);
      await first.untilInitialized();
      const second = connect(wt);
      expect((await first.untilClosed()).code).toBe(LSP_REPLACED_CLOSE_CODE);
      await second.untilInitialized();
    });
  });

  describe("messages", () => {
    test("no dotnet: install the SDK, then the tool", async () => {
      await installToolchain({ dotnet: false, csharpLs: null });
      const socket = connect(await makeRestoredRepo());
      expect(await socket.untilMessage("Install the .NET 10 SDK")).toContain(
        "dotnet tool install --global csharp-ls",
      );
    });

    for (const [sdk, runtime] of [
      ["8.0.100", "8.0.0"],
      ["9.0.100", "9.0.0"],
    ] as const) {
      test(`SDK ${sdk} alone: install the .NET 10 SDK next to it, then the tool`, async () => {
        await installToolchain({ sdk, runtime, csharpLs: null });
        const socket = connect(await makeRestoredRepo());
        const message = await socket.untilMessage("needs .NET 10");
        expect(message).toContain("next to the ones you have");
        expect(message).toContain("dotnet tool install --global csharp-ls");
      });
    }

    test("csharp-ls installed but no .NET 10: no install step", async () => {
      await installToolchain({ sdk: "8.0.100", runtime: "8.0.0" });
      const socket = connect(await makeRestoredRepo());
      expect(await socket.untilMessage("needs .NET 10")).not.toContain("dotnet tool install");
    });

    test("an older SDK with a .NET 10 runtime cannot install the tool", async () => {
      await installToolchain({ sdk: "8.0.100", runtime: "10.0.0", csharpLs: null });
      const socket = connect(await makeRestoredRepo());
      await socket.untilMessage("Installing csharp-ls needs the .NET 10 SDK");
    });

    test("SDK 10 with no csharp-ls: the command", async () => {
      await installToolchain({ csharpLs: null });
      const socket = connect(await makeRestoredRepo());
      expect(await socket.untilMessage("dotnet tool install --global csharp-ls")).not.toContain(
        "outside this repository",
      );
    });

    test("too old: the update command, and no process", async () => {
      await installToolchain({ csharpLs: "0.23.0" });
      const socket = connect(await makeRestoredRepo());
      const message = await socket.untilMessage("dotnet tool update --global csharp-ls");
      expect(message).toContain(MIN_CSHARP_LS_VERSION);
      expect(isHold(await socket.untilInitialized())).toBe(true);
    });

    test("global.json selecting a missing SDK names it", async () => {
      await installToolchain();
      const socket = connect(
        await makeRestoredRepo({ "global.json": '{"sdk":{"version":"7.0.100"}}' }),
      );
      await socket.untilMessage(".NET SDK 7.0.100");
    });

    test("rechecks decide nothing while the toolchain looks the same", async () => {
      const { bin } = await installToolchain({ csharpLs: null });
      const wt = await makeRestoredRepo();
      const counting = new CountingManager();
      manager = counting;
      const socket = connect(wt);
      await socket.untilMessage("dotnet tool install");
      // The first tick that finds no decision running takes one more, to have a stamp to compare.
      // Then a stretch of ticks passes with none, or this runs into the test's timeout. A
      // login-shell capture comes every few ticks, so captures count ticks.
      for (;;) {
        const { started, refreshes } = counting;
        await counting.until(() => counting.refreshes >= refreshes + 2);
        if (counting.started === started) break;
      }
      await writeExecutable(join(bin, "csharp-ls"), fakeCSharpLs("0.23.0"));
      await socket.untilMessage("dotnet tool update");
    });

    test("each message goes out once per connection across rechecks", async () => {
      const { bin } = await installToolchain({ csharpLs: null });
      const socket = connect(await makeRestoredRepo());
      await socket.untilMessage("dotnet tool install");
      // A later recheck that changes what it says proves the ones between stayed quiet.
      await writeExecutable(join(bin, "csharp-ls"), fakeCSharpLs("0.23.0"));
      await socket.untilMessage("dotnet tool update");
      expect(socket.messages()).toHaveLength(2);
    });
  });

  describe("server", () => {
    test("a project naming a NuGet SDK gets the word, and bundled SDKs none", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo({
        "Lib/Lib.csproj": '<Project Sdk="Some.Package.Sdk/1.2.3"></Project>',
        "Web/Web.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      });
      const socket = connect(wt);
      const message = await socket.untilMessage("MSBuild SDK from NuGet");
      expect(message).toContain("Lib.csproj");
      expect(message).not.toContain("Web.csproj");
      const { nugetResolver } = (await socket.untilInitialized()) as { nugetResolver: string };
      expect(nugetResolver).toBe("1");
    });

    test("restarts for a restored state stop at the cap", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo();
      manager = new TestManager();
      for (let restarts = 0; restarts < 3; restarts++) {
        const socket = connect(wt);
        await socket.untilInitialized();
        manager.notifyWatchedFilesChanged(wt, [join(wt, "obj", "project.assets.json")]);
        expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
        manager.destroySession(socket.ws);
      }
      const last = connect(wt);
      await last.untilInitialized();
      manager.notifyWatchedFilesChanged(wt, [join(wt, "obj", "project.assets.json")]);
      // The load failure the stand-in reports comes after the settle time, on the same timer length.
      await last.untilMessage("could not load");
      expect(last.frames.some((frame) => frame.id === 1)).toBe(true);
    });

    test("checks that never finish still answer initialize, and try again", async () => {
      const { bin } = await installToolchain();
      await writeExecutable(join(bin, "dotnet"), `#!/bin/sh\nsleep 100 &\nwait\n`);
      const wt = await makeRestoredRepo();
      manager = new StallingTestManager();
      const socket = connect(wt);
      expect(isHold(await socket.untilInitialized())).toBe(true);
      await fakeDotnet(bin, "10.0.100", "10.0.0");
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("runs in the worktree with its settings and the runtime's root", async () => {
      const { bin } = await installToolchain();
      const wt = await makeRestoredRepo();
      const socket = connect(wt);
      const result = await socket.untilInitialized();
      expect(result.args).toEqual([
        "--loglevel",
        "information",
        "--solution",
        projectsSolutionPath(wt),
      ]);
      expect(result.cwd).toBe(wt);
      expect(result.dotnetRoot).toBe(bin);
      expect(result.nodeReuse).toBe("1");
      const configuration = await socket.untilFrame(
        (frame) => frame.method === "test/configuration",
      );
      expect(configuration.params).toEqual([CSHARP_LS_SETTINGS, null]);
    });

    test("finds a global tool that is not on PATH", async () => {
      await installToolchain({ csharpLs: null });
      const wt = await makeRestoredRepo();
      await writeExecutable(
        join(process.env.HOME ?? "", ".dotnet", "tools", "csharp-ls"),
        fakeCSharpLs("0.28.0"),
      );
      expect(isHold(await connect(wt).untilInitialized())).toBe(false);
    });

    test("does not take a csharp-ls from the worktree", async () => {
      const { bin } = await installToolchain({ csharpLs: null });
      const wt = await makeRestoredRepo({ "tools/csharp-ls": fakeCSharpLs("0.28.0") });
      await chmod(join(wt, "tools", "csharp-ls"), 0o755);
      process.env.PATH = [join(wt, "tools"), process.env.PATH].join(delimiter);
      const socket = connect(wt);
      await socket.untilMessage("dotnet tool install");
      expect(bin).not.toBe(join(wt, "tools"));
    });

    test("a tool the manifest lists outranks the global one, through dotnet", async () => {
      const { dotnetRuns } = await installToolchain();
      const wt = await makeRestoredRepo({
        ".config/dotnet-tools.json":
          '{"version":1,"tools":{"csharp-ls":{"version":"0.28.0","commands":["csharp-ls"]}}}',
      });
      const socket = connect(wt);
      // The stand-in `dotnet` runs no tool, so this one is told what to do.
      await socket.untilMessage("dotnet tool restore");
      expect(await Bun.file(dotnetRuns).text()).toContain("tool run csharp-ls -- --version");
    });

    test("a dotnet tool restore opens the gate, with the local tool cache already there", async () => {
      await installToolchain();
      await mkdir(join(process.env.HOME ?? "", ".dotnet", "toolResolverCache", "1"), {
        recursive: true,
      });
      const wt = await makeRestoredRepo({
        ".config/dotnet-tools.json":
          '{"version":1,"tools":{"csharp-ls":{"version":"0.28.0","commands":["csharp-ls"]}}}',
      });
      const held = connect(wt);
      await held.untilMessage("dotnet tool restore");
      await write(join(process.env.HOME ?? "", ".dotnet", "toolResolverCache", "1", "csharp-ls"));
      expect((await held.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("with no solution it loads the discovered projects, not what is on disk", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo({
        ".gitignore": "obj/\nbin/\nskipped/\n",
        "lib/Lib.csproj": PROJECT,
        "skipped/Skipped.csproj": PROJECT,
      });
      const nested = join(wt, "nested");
      await write(join(nested, "Nested.csproj"), PROJECT);
      await write(join(nested, "Nested.slnx"), "");
      await git(nested, "init", "-q");
      const result = await connect(wt).untilInitialized();
      expect(result.args).toEqual([
        "--loglevel",
        "information",
        "--solution",
        projectsSolutionPath(wt),
      ]);
      const listed = await Bun.file(projectsSolutionPath(wt)).text();
      expect(listed).toContain(join(wt, "App.csproj"));
      expect(listed).toContain(join(wt, "lib", "Lib.csproj"));
      expect(listed).not.toContain("Nested.csproj");
      expect(listed).not.toContain("Skipped.csproj");
    });

    test("a project added beside a listed one restarts the server, restored or not", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo();
      const socket = connect(wt);
      await socket.untilInitialized();
      const added = join(wt, "lib", "Lib.csproj");
      await write(added, PROJECT);
      manager?.notifyWatchedFilesChanged(wt, [added]);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
      expect(await Bun.file(projectsSolutionPath(wt)).text()).not.toContain("Lib.csproj");
      manager?.destroySession(socket.ws);
      await connect(wt).untilInitialized();
      expect(await Bun.file(projectsSolutionPath(wt)).text()).toContain("Lib.csproj");
    });

    test("a directory newly ignored restarts a server listing its project", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo({ "lib/Lib.csproj": PROJECT });
      const socket = connect(wt);
      await socket.untilInitialized();
      expect(await Bun.file(projectsSolutionPath(wt)).text()).toContain("Lib.csproj");
      const ignore = await write(join(wt, ".gitignore"), "obj/\nbin/\nlib/\n");
      manager?.notifyWatchedFilesChanged(wt, [ignore]);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("no list of projects means no server, until it can be written", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo();
      const blocker = dirname(projectsSolutionPath(wt));
      await write(blocker);
      const socket = connect(wt);
      expect(isHold(await socket.untilInitialized())).toBe(true);
      await rm(blocker);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("one solution at the root is what loads, with no word about others", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo({ "Root.sln": '"App.csproj"', "samples/Other.sln": "" });
      const socket = connect(wt);
      const result = await socket.untilInitialized();
      expect(result.args).toEqual([
        "--loglevel",
        "information",
        "--solution",
        join(wt, "Root.sln"),
      ]);
      await socket.untilFrame((frame) => frame.method === "test/configuration");
      expect(socket.messages().filter((message) => message.includes("solutions"))).toEqual([]);
    });

    test("solutions in subfolders: the first loads, and the user is told which", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo({ "a/A.sln": "", "b/B.sln": "" });
      const socket = connect(wt);
      const result = await socket.untilInitialized();
      expect(result.args).toEqual(["--loglevel", "information", "--solution", join(wt, "a/A.sln")]);
      expect(await socket.untilMessage("2 solutions")).toContain(join("a", "A.sln"));
    });

    test("only projects the solution lists decide the gate and the not-restored word", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo({
        "Root.sln": '"App.csproj" "Lib\\Lib.csproj"',
        "Lib/Lib.csproj": PROJECT,
        "samples/Sample.csproj": PROJECT,
      });
      const socket = connect(wt);
      const message = await socket.untilMessage("not restored");
      expect(message).toContain("Lib.csproj");
      expect(message).not.toContain("Sample.csproj");
    });

    test("nothing restored among what would load keeps it held", async () => {
      await installToolchain();
      const wt = await makeRepo({
        "Root.sln": '"App.csproj"',
        "App.csproj": PROJECT,
        "samples/Sample.csproj": PROJECT,
        "samples/obj/project.assets.json": "{}",
      });
      setRepoTrusted(wt, true);
      const socket = connect(wt);
      await socket.untilMessage("dotnet restore");
      expect(isHold(await socket.untilInitialized())).toBe(true);
    });

    test("a project that fails to load is told once, by name", async () => {
      await installToolchain();
      const socket = connect(await makeRestoredRepo());
      const message = await socket.untilMessage("could not load");
      expect(message).toContain("Broken.csproj");
      expect(message).toContain("No target.");
    });

    test("a rewritten assets file restarts the server, since it reads them only at load", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo();
      const socket = connect(wt);
      await socket.untilInitialized();
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "obj", "project.assets.json")]);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("stopping the server ends what it started, in another process group too", async () => {
      await installToolchain();
      const socket = connect(await makeRestoredRepo());
      await socket.untilInitialized();
      manager?.handleMessage(
        socket.ws,
        JSON.stringify({ jsonrpc: "2.0", method: "test/startChild", params: {} }),
      );
      const started = await socket.untilFrame((frame) => frame.method === "test/childStarted");
      const { pid } = started.params as { pid: number };
      try {
        expect(isRunning(pid)).toBe(true);
        manager?.destroySession(socket.ws);
        while (isRunning(pid)) await Bun.sleep(20);
      } finally {
        // A failure must not leave it running.
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    });

    test("trust taken away restarts the server into a hold", async () => {
      await installToolchain();
      const wt = await makeRestoredRepo();
      const socket = connect(wt);
      await socket.untilInitialized();
      setRepoTrusted(wt, false);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
      manager?.destroySession(socket.ws);
      expect(isHold(await connect(wt).untilInitialized())).toBe(true);
    });
  });
});

/** Waits for what the manager publishes for a worktree to satisfy `done`. */
async function untilState(
  wt: string,
  done: (state: ReturnType<typeof getCSharpLspState>) => boolean,
): Promise<ReturnType<typeof getCSharpLspState>> {
  while (!done(getCSharpLspState(wt))) {
    await new Promise<void>((resolve) => {
      const stop = subscribeCSharpStatus(wt, () => {
        stop();
        resolve();
      });
    });
  }
  return getCSharpLspState(wt);
}

const blockedBy = (block: string) => (state: ReturnType<typeof getCSharpLspState>) =>
  state?.kind === "blocked" && state.block === block;

describe.skipIf(process.platform === "win32")("what the status shows", () => {
  test("not trusted, then running once trusted, with no reload", async () => {
    await installToolchain();
    const wt = await makeRepo({ "App.csproj": PROJECT, "obj/project.assets.json": "{}" });
    const held = connect(wt);
    await held.untilInitialized();
    await untilState(wt, blockedBy("untrusted"));
    setRepoTrusted(wt, true);
    expect((await held.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    manager?.destroySession(held.ws);
    connect(wt);
    expect(await untilState(wt, (state) => state?.kind === "running")).toEqual({
      kind: "running",
      target: null,
      projects: [join(wt, "App.csproj")],
      sdkVersion: "10.0.100",
    });
  });

  test("a repository with no project", async () => {
    await installToolchain();
    const wt = await makeRepo({ "Loose.cs": "" });
    setRepoTrusted(wt, true);
    connect(wt);
    await untilState(wt, (state) => state?.kind === "no-project");
  });

  test("each missing step, in the words of the notice", async () => {
    const cases = [
      { options: { dotnet: false }, block: "no-dotnet" },
      { options: { csharpLs: null }, block: "no-csharp-ls" },
      { options: { csharpLs: "0.20.0" }, block: "old-csharp-ls" },
    ];
    for (const { options, block } of cases) {
      await installToolchain(options);
      const wt = await makeRestoredRepo();
      const socket = connect(wt);
      const state = await untilState(wt, blockedBy(block));
      const message = state?.kind === "blocked" ? state.message : "";
      expect(await socket.untilMessage(message)).toBe(message);
      manager?.destroySession(socket.ws);
    }
  });

  /** Holds on to each session, and lets a test replay what the base does late. */
  class LateFramesManager extends TestManager {
    readonly built: WtLspSession[] = [];
    protected override buildSession(...args: Parameters<TestManager["buildSession"]>) {
      const session = super.buildSession(...args);
      this.built.push(session);
      return session;
    }
    closeAgain(session: WtLspSession): void {
      this.onSessionClosed(session);
    }
    frame(session: WtLspSession, body: string): void {
      this.handleServerFrame(session, body);
    }
  }

  test("an old server that exits, or speaks, late does not replace a newer decision", async () => {
    await installToolchain();
    const wt = await makeRestoredRepo();
    const late = new LateFramesManager();
    manager = late;
    const first = connect(wt);
    await first.untilInitialized();
    manager.destroySession(first.ws);
    expect(getCSharpLspState(wt)).toEqual({ kind: "stopped" });
    const second = connect(wt);
    await second.untilInitialized();
    const running = await untilState(wt, (state) => state?.kind === "running");

    const old = late.built[0]!;
    late.closeAgain(old);
    late.frame(
      old,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "window/showMessage",
        params: { type: 1, message: "Solution could not be loaded" },
      }),
    );
    expect(getCSharpLspState(wt)).toEqual(running);
  });

  test("a live server's failed solution is shown, on its first line", async () => {
    await installToolchain();
    const wt = await makeRestoredRepo();
    const late = new LateFramesManager();
    manager = late;
    await connect(wt).untilInitialized();
    late.frame(
      late.built[0]!,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "window/showMessage",
        params: { type: 1, message: "Solution could not be loaded: x\n  at stack" },
      }),
    );
    expect(getCSharpLspState(wt)).toEqual({
      kind: "blocked",
      block: "load-failed",
      message: "Solution could not be loaded: x",
    });
  });

  test("not restored, in the words of the notice", async () => {
    await installToolchain();
    const wt = await makeRepo({ "App.csproj": PROJECT });
    setRepoTrusted(wt, true);
    const socket = connect(wt);
    const state = await untilState(wt, blockedBy("not-restored"));
    expect(state?.kind === "blocked" && state.message).toContain("dotnet restore");
    await socket.untilMessage("dotnet restore");
  });
});

describe.skipIf(process.platform === "win32")("a chosen solution", () => {
  const argsOf = async (socket: ReturnType<typeof connect>) =>
    (await socket.untilInitialized()).args;
  const loading = (file: string) => ["--loglevel", "information", "--solution", file];

  test("loads instead of the first, with no word about the others", async () => {
    await installToolchain();
    const wt = await makeRestoredRepo({ "a/A.sln": "", "b/B.sln": "" });
    setCSharpSolution(wt, join(wt, "b/B.sln"));
    const socket = connect(wt);
    expect(await argsOf(socket)).toEqual(loading(join(wt, "b/B.sln")));
    await socket.untilFrame((frame) => frame.method === "test/configuration");
    expect(socket.messages().filter((message) => message.includes("solutions"))).toEqual([]);
  });

  test("the multi-solution notice points at the picker", async () => {
    await installToolchain();
    const wt = await makeRestoredRepo({ "a/A.sln": "", "b/B.sln": "" });
    expect(await connect(wt).untilMessage("2 solutions")).toContain("C#: Select Solution");
  });

  test("choosing restarts a server loading something else, and not one already loading it", async () => {
    await installToolchain();
    const wt = await makeRestoredRepo({ "a/A.sln": "", "b/B.sln": "" });
    const first = connect(wt);
    await first.untilInitialized();
    setCSharpSolution(wt, join(wt, "a/A.sln"));
    setCSharpSolution(wt, join(wt, "b/B.sln"));
    expect((await first.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    manager?.destroySession(first.ws);
    const second = connect(wt);
    expect(await argsOf(second)).toEqual(loading(join(wt, "b/B.sln")));
  });

  test("a filter's own projects decide the gate, relative to the solution it filters", async () => {
    await installToolchain();
    const filter = JSON.stringify({
      solution: { path: "sub/All.sln", projects: ["..\\Lib\\Lib.csproj"] },
    });
    const wt = await makeRestoredRepo({
      "sub/All.sln": "",
      "Only.slnf": `\uFEFF${filter}`,
      "Lib/Lib.csproj": PROJECT,
    });
    setCSharpSolution(wt, join(wt, "Only.slnf"));
    const socket = connect(wt);
    await socket.untilInitialized();
    await untilState(wt, blockedBy("not-restored"));
    await write(join(wt, "Lib/obj/project.assets.json"), "{}");
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "Lib/Lib.csproj")]);
    expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    manager?.destroySession(socket.ws);
    expect(await argsOf(connect(wt))).toEqual(loading(join(wt, "Only.slnf")));
  });

  test("a chosen file that goes away falls back to detection, and comes back with it", async () => {
    await installToolchain();
    const wt = await makeRestoredRepo({ "a/A.sln": "", "b/B.sln": "" });
    const chosen = join(wt, "b/B.sln");
    setCSharpSolution(wt, chosen);
    const first = connect(wt);
    await first.untilInitialized();

    await rm(chosen);
    manager?.notifyWatchedFilesChanged(wt, [chosen]);
    expect((await first.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    manager?.destroySession(first.ws);
    const second = connect(wt);
    // With one solution left at no root, detection picks it, and nothing needs saying.
    expect(await argsOf(second)).toEqual(loading(join(wt, "a/A.sln")));

    await write(chosen);
    manager?.notifyWatchedFilesChanged(wt, [chosen]);
    expect((await second.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    manager?.destroySession(second.ws);
    expect(await argsOf(connect(wt))).toEqual(loading(chosen));
  });

  test("choosing does not open the gate of an untrusted repository", async () => {
    const { dotnetRuns } = await installToolchain();
    const wt = await makeRepo({
      "App.csproj": PROJECT,
      "obj/project.assets.json": "{}",
      "A.sln": "",
    });
    setCSharpSolution(wt, join(wt, "A.sln"));
    const socket = connect(wt);
    expect(isHold(await socket.untilInitialized())).toBe(true);
    await untilState(wt, blockedBy("untrusted"));
    expect(await Bun.file(dotnetRuns).exists()).toBe(false);
  });
});

describe("withClientRegistrations", () => {
  const registrations = (entries: string[]) =>
    JSON.stringify({
      id: 1,
      method: "client/registerCapability",
      params: { registrations: entries.map((method) => ({ id: method, method })) },
    });

  test("names semantic tokens as the client does and drops code lenses", () => {
    const frame = JSON.parse(
      withClientRegistrations(
        registrations([
          "textDocument/hover",
          "textDocument/semanticTokens",
          "textDocument/codeLens",
        ]),
      ),
    ) as { params: { registrations: { method: string }[] } };
    expect(frame.params.registrations.map((entry) => entry.method)).toEqual([
      "textDocument/hover",
      "textDocument/semanticTokens/full",
    ]);
  });

  test("leaves other frames as they are", () => {
    const other = '{"method":"window/logMessage","params":{"message":"textDocument/codeLens"}}';
    expect(withClientRegistrations(other)).toBe(other);
  });
});
