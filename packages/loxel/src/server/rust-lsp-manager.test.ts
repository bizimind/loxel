import { afterAll, afterEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { ServerWebSocket } from "bun";

import type { RustToolchain } from "@/api/rust-toolchain-model";
import { LSP_RESTART_CLOSE_CODE, LSP_START_FAILED_CLOSE_CODE } from "@/api/ws-protocol";

// Each test spawns git and fake tools; on a loaded machine that takes far longer than the default.
setDefaultTimeout(120_000);

// The fakes here are scripts, which the lookup refuses; `rust-tool-shim.test.ts` covers that.
mock.module("./rust-tool-shim", () => ({ isVersionManagerShim: async () => false }));

const stateDir = await mkdtemp(join(tmpdir(), "rust-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const {
  findRustManifests,
  isRustManifestPath,
  MIN_RUST_ANALYZER_DATE,
  planRustAnalyzer,
  rustAnalyzerDate,
  rustAnalyzerEnv,
  rustAnalyzerSettings,
} = await import("./rust-analyzer-run");
const { RustLspManager } = await import("./rust-lsp-manager");

const roots: string[] = [];
let manager: InstanceType<typeof RustLspManager> | undefined;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

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

async function writeExecutable(file: string, script: string): Promise<void> {
  await writeFile(file, script);
  await chmod(file, 0o755);
}

/** Stands in for rust-analyzer: answers `--version`, and reports what it was started with. */
const fakeRustAnalyzer = (version: string) => `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log(${JSON.stringify(version)});
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
    if (msg.method !== "initialize") continue;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        args: process.argv.slice(2),
        cwd: process.cwd(),
        env: process.env,
        settings: msg.params.initializationOptions,
        capabilities: {
          documentFormattingProvider: true,
          documentRangeFormattingProvider: true,
          hoverProvider: true,
        },
      },
    });
  }
});
`;

const RECENT = "rust-analyzer 1.99.1 (58cf8f9c 2026-10-13)";
const FAKE_RUSTC = `#!/bin/sh
case "$1" in
  --version) echo "rustc 1.99.1 (58cf8f9c3 2026-10-13)" ;;
  -vV) printf 'rustc 1.99.1\\nhost: fake-host-triple\\n' ;;
  --print) echo "\${0%/bin/rustc}" ;;
esac
`;

/** A Rust installed without rustup, under a fresh root, and a PATH limited to it and `git`. */
async function installFakeRust(analyzer: string | null = fakeRustAnalyzer(RECENT)) {
  const root = await makeDir("rust-install-");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeExecutable(join(bin, "rustc"), FAKE_RUSTC);
  await writeExecutable(join(bin, "cargo"), "#!/bin/sh\n");
  if (analyzer) await writeExecutable(join(bin, "rust-analyzer"), analyzer);
  process.env.HOME = await makeDir("rust-home-");
  const gitDir = await makeDir("rust-git-");
  await symlink(Bun.which("git") ?? "git", join(gitDir, "git"));
  process.env.PATH = [bin, gitDir].join(delimiter);
  return { root, bin };
}

/** Stands in for the WebSocket and the Monaco client behind it. */
function fakeSocket() {
  const frames: Record<string, any>[] = [];
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
  return {
    ws,
    untilClosed: () => until(() => close),
    untilFrame: (match: (frame: Record<string, any>) => boolean) => until(() => frames.find(match)),
  };
}

const frame = (message: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...message });
const INITIALIZE = frame({ id: 1, method: "initialize", params: { capabilities: {} } });
const INITIALIZED = frame({ method: "initialized", params: {} });

function activeToolchain(
  overrides: Partial<Extract<RustToolchain, { status: "active" }>> = {},
  tools: Partial<Extract<RustToolchain, { status: "active" }>["tools"]> = {},
): Extract<RustToolchain, { status: "active" }> {
  return {
    status: "active",
    source: "default",
    name: "stable-host",
    version: "1.99.1",
    rustcPath: "/toolchain/bin/rustc",
    sysroot: "/toolchain",
    toolchainFile: null,
    tools: {
      cargo: "/toolchain/bin/cargo",
      rustfmt: null,
      cargoClippy: null,
      rustAnalyzer: "/toolchain/bin/rust-analyzer",
      rustSrc: true,
      ...tools,
    },
    ...overrides,
  };
}

describe("rustAnalyzerDate", () => {
  test("reads the component's and the standalone release's formats", () => {
    expect(rustAnalyzerDate("rust-analyzer 1.99.1 (58cf8f9c 2026-10-13)\n")).toBe("2026-10-13");
    expect(rustAnalyzerDate("rust-analyzer 0.3.3097-standalone (0c4d74686b 2026-10-22)\n")).toBe(
      "2026-10-22",
    );
  });

  test("finds nothing in output without a date", () => {
    expect(rustAnalyzerDate("rust-analyzer 1.99.1\n")).toBeNull();
    expect(rustAnalyzerDate("")).toBeNull();
  });
});

describe("planRustAnalyzer", () => {
  const reasonFor = async (toolchain: RustToolchain) => {
    const plan = await planRustAnalyzer("/wt", toolchain);
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    return plan.reason;
  };

  test("says what to run for each toolchain nothing can run from", async () => {
    expect(
      await reasonFor({
        status: "not-installed",
        source: "toolchain-file",
        name: "1.90.0-host",
        toolchainFile: "/wt/rust-toolchain.toml",
      }),
    ).toContain("rustup toolchain install 1.90.0-host");
    expect(
      await reasonFor({
        status: "refused",
        name: "x",
        toolchainFile: "/wt/rust-toolchain.toml",
        rustcPath: "/wt/bin/rustc",
      }),
    ).toContain("Rust: Select Toolchain");
    expect(await reasonFor({ status: "none", rustupPath: "/r", detail: null })).toContain(
      "rustup default stable",
    );
    expect(await reasonFor({ status: "none", rustupPath: null, detail: null })).toContain(
      "https://rustup.rs",
    );
  });

  test("says how to add a missing component", async () => {
    expect(await reasonFor(activeToolchain({}, { rustAnalyzer: null }))).toContain(
      "rustup component add rust-analyzer --toolchain stable-host",
    );
  });

  test("refuses a toolchain a toolchain file selects by path", async () => {
    expect(
      await reasonFor(activeToolchain({ source: "toolchain-file", name: "/elsewhere/toolchain" })),
    ).toContain("by path");
  });

  async function planWithVersion(version: string) {
    const { bin, root } = await installFakeRust(fakeRustAnalyzer(version));
    return planRustAnalyzer(
      await makeDir("rust-wt-"),
      activeToolchain(
        { rustcPath: join(bin, "rustc"), sysroot: root },
        { rustAnalyzer: join(bin, "rust-analyzer"), cargo: join(bin, "cargo") },
      ),
    );
  }

  test("starts no server below the oldest supported version, nor with an unreadable one", async () => {
    const old = await planWithVersion("rust-analyzer 1.83.0 (90b35a62 2024-11-26)");
    expect(old).toMatchObject({ kind: "refuse", reason: expect.stringContaining("too old") });
    const unreadable = await planWithVersion("rust-analyzer");
    expect(unreadable).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("version"),
    });
  });

  test("starts the oldest supported version", async () => {
    const plan = await planWithVersion(`rust-analyzer 1.0.0 (abc ${MIN_RUST_ANALYZER_DATE})`);
    expect(plan.kind).toBe("run");
  });
});

describe("rustAnalyzerEnv", () => {
  test("pins the toolchain, and takes every tool setting away from cargo's config", () => {
    const env = rustAnalyzerEnv(activeToolchain(), "/c/cargo", "/a:/wt/tools:/b", "/wt");
    expect(env).toMatchObject({
      RUSTUP_TOOLCHAIN: "stable-host",
      RUSTUP_AUTO_INSTALL: "0",
      PATH: "/a:/b",
      CARGO: "/c/cargo",
      RUSTC: "/toolchain/bin/rustc",
      RUSTC_WRAPPER: "",
      RUSTC_WORKSPACE_WRAPPER: "",
      CARGO_ENCODED_RUSTFLAGS: "",
      CARGO_NET_OFFLINE: "true",
    });
  });

  test("names no rustup toolchain for an install without rustup", () => {
    const env = rustAnalyzerEnv(activeToolchain({ name: null }), "/c", "/a", "/wt");
    expect(env.RUSTUP_TOOLCHAIN).toBeUndefined();
  });
});

describe("rustAnalyzerSettings", () => {
  test("turns off what runs project code, and lists the projects", () => {
    expect(
      rustAnalyzerSettings({ sysroot: "/sys", host: "h", rustSrc: true }, ["/wt/Cargo.toml"]),
    ).toEqual({
      checkOnSave: false,
      cargo: { buildScripts: { enable: false }, sysroot: "/sys", target: "h" },
      procMacro: { enable: false },
      linkedProjects: ["/wt/Cargo.toml"],
    });
  });

  test("lists an empty project without a manifest, so none is looked for", () => {
    const { linkedProjects } = rustAnalyzerSettings(
      { sysroot: "/sys", host: "h", rustSrc: true },
      [],
    );
    expect(linkedProjects).toEqual([{ sysroot: null, crates: [] }]);
  });
});

describe("findRustManifests", () => {
  test("takes the worktree's own manifest alone", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, "a"));
    await writeFile(join(wt, "Cargo.toml"), "");
    await writeFile(join(wt, "a", "Cargo.toml"), "");
    expect(findRustManifests(wt)).toEqual([join(wt, "Cargo.toml")]);
  });

  test("takes those one directory down, and no project files", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, "b"));
    await mkdir(join(wt, "a", "deep"), { recursive: true });
    await writeFile(join(wt, "b", "Cargo.toml"), "");
    await writeFile(join(wt, "a", "Cargo.toml"), "");
    await writeFile(join(wt, "a", "deep", "Cargo.toml"), "");
    await writeFile(join(wt, "rust-project.json"), "{}");
    expect(findRustManifests(wt)).toEqual([
      join(wt, "a", "Cargo.toml"),
      join(wt, "b", "Cargo.toml"),
    ]);
  });

  test("finds nothing in a worktree without one", async () => {
    expect(findRustManifests(await makeDir("rust-wt-"))).toEqual([]);
  });

  test("knows which changed files can matter", () => {
    expect(isRustManifestPath("/wt", "/wt/Cargo.toml")).toBe(true);
    expect(isRustManifestPath("/wt", "/wt/a/Cargo.toml")).toBe(true);
    expect(isRustManifestPath("/wt", "/wt/a/b/Cargo.toml")).toBe(false);
    expect(isRustManifestPath("/wt", "/wt/src/main.rs")).toBe(false);
  });
});

describe("RustLspManager", () => {
  async function start(wt: string) {
    manager = new RustLspManager();
    const socket = fakeSocket();
    manager.createSession(socket.ws, wt);
    manager.handleMessage(socket.ws, INITIALIZE);
    return socket;
  }

  test("runs the toolchain's rust-analyzer restricted, with no formatting", async () => {
    const { bin, root } = await installFakeRust();
    const wt = await makeDir("rust-wt-");
    await writeFile(join(wt, "Cargo.toml"), "");
    const socket = await start(wt);

    const { result } = await socket.untilFrame((message) => message.id === 1);
    expect(result.args).toEqual([]);
    expect(result.cwd).toBe(wt);
    expect(result.env).toMatchObject({
      RUSTC: join(bin, "rustc"),
      CARGO: join(bin, "cargo"),
      RUSTC_WRAPPER: "",
      CARGO_NET_OFFLINE: "true",
      RUSTUP_AUTO_INSTALL: "0",
    });
    expect(result.settings).toEqual({
      checkOnSave: false,
      cargo: { buildScripts: { enable: false }, sysroot: root, target: "fake-host-triple" },
      procMacro: { enable: false },
      linkedProjects: [join(wt, "Cargo.toml")],
    });
    expect(Object.keys(result.capabilities)).toEqual(["hoverProvider"]);
  });

  test("closes with what to do when rust-analyzer is missing", async () => {
    await installFakeRust(null);
    const socket = await start(await makeDir("rust-wt-"));
    const closed = await socket.untilClosed();
    expect(closed.code).toBe(LSP_START_FAILED_CLOSE_CODE);
    expect(closed.reason).toContain("rust-analyzer was not found");
  });

  test("closes below the oldest supported version", async () => {
    await installFakeRust(fakeRustAnalyzer("rust-analyzer 1.83.0 (90b35a62 2024-11-26)"));
    const socket = await start(await makeDir("rust-wt-"));
    const closed = await socket.untilClosed();
    expect(closed.code).toBe(LSP_START_FAILED_CLOSE_CODE);
    expect(closed.reason).toContain("too old");
  });

  test("says what to run when the standard library's sources are missing", async () => {
    await installFakeRust();
    const socket = await start(await makeDir("rust-wt-"));
    await socket.untilFrame((message) => message.id === 1);
    manager?.handleMessage(socket.ws, INITIALIZED);
    const { params } = await socket.untilFrame(
      (message) => message.method === "window/showMessage",
    );
    expect(params.message).toContain("rustup component add rust-src");
  });

  test("restarts when the worktree's manifests change, and not for other files", async () => {
    await installFakeRust();
    const wt = await makeDir("rust-wt-");
    const socket = await start(wt);
    await socket.untilFrame((message) => message.id === 1);

    manager?.notifyWatchedFilesChanged(wt, [join(wt, "Cargo.toml")]);
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "src", "main.rs")]);
    await writeFile(join(wt, "Cargo.toml"), "");
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "Cargo.toml")]);

    const closed = await socket.untilClosed();
    expect(closed.code).toBe(LSP_RESTART_CLOSE_CODE);
  });
});
