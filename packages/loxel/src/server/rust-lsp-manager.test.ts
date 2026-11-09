import {
  afterAll,
  afterEach,
  describe,
  expect,
  jest,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
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
  blockedClientMethod,
  findRustManifests,
  isRustManifestPath,
  MIN_RUST_ANALYZER_DATE,
  planRustAnalyzer,
  readDocumentLifecycle,
  readServerStatus,
  rustAnalyzerDate,
  rustAnalyzerEnv,
  rustAnalyzerSettings,
  rustManifestProblem,
  withoutPullDiagnostics,
  withRustClientCapabilities,
} = await import("./rust-analyzer-run");
const { MAX_OPENED_RUST_PROJECTS, RustLspManager } = await import("./rust-lsp-manager");
const { CHECK_QUIET_MS } = await import("./rust-check-on-change");
const { refreshRustToolchain } = await import("./rust-toolchain");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");
const { untrustedNestedRepo } = await import("./rust-project-lookup");

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
    if (msg.method === "textDocument/didSave") {
      send({ jsonrpc: "2.0", method: "test/saved", params: { uri: msg.params.textDocument.uri } });
      continue;
    }
    if (msg.method === "test/ping") {
      send({ jsonrpc: "2.0", method: "test/pong", params: {} });
      continue;
    }
    if (msg.method === "test/startChild") {
      const child = Bun.spawn(["/bin/sleep", "1000"]);
      send({ jsonrpc: "2.0", method: "test/childStarted", params: { pid: child.pid } });
      continue;
    }
    if (msg.method === "workspace/didChangeConfiguration") {
      const items = [{ section: "rust-analyzer" }];
      send({ jsonrpc: "2.0", id: "pull", method: "workspace/configuration", params: { items } });
      continue;
    }
    if (msg.id === "pull") {
      send({ jsonrpc: "2.0", method: "test/pulled", params: { settings: msg.result[0] } });
      continue;
    }
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
          diagnosticProvider: { identifier: "rust-analyzer" },
        },
      },
    });
    for (let i = 0; i < 2; i++) {
      send({
        jsonrpc: "2.0",
        method: "experimental/serverStatus",
        params: { health: "warning", message: "Failed to read Cargo metadata with dependencies" },
      });
    }
    send({ jsonrpc: "2.0", method: "test/after-status" });
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
async function installFakeRust(
  analyzer: string | null = fakeRustAnalyzer(RECENT),
  { rustSrc = true } = {},
) {
  const root = await makeDir("rust-install-");
  const bin = join(root, "bin");
  await mkdir(bin);
  if (rustSrc) await mkdir(join(root, "lib/rustlib/src/rust/library"), { recursive: true });
  await writeExecutable(join(bin, "rustc"), FAKE_RUSTC);
  await writeExecutable(join(bin, "cargo"), "#!/bin/sh\n");
  if (analyzer) await writeExecutable(join(bin, "rust-analyzer"), analyzer);
  process.env.HOME = await makeDir("rust-home-");
  const gitDir = await makeDir("rust-git-");
  await symlink(Bun.which("git") ?? "git", join(gitDir, "git"));
  process.env.PATH = [bin, gitDir].join(delimiter);
  return { root, bin };
}

/** What the fake server and the manager send; each test reads the fields its frame has. */
interface TestFrame {
  id?: number;
  method?: string;
  params: {
    message: string;
    settings: Record<string, unknown> & { linkedProjects: unknown[] };
    uri: string;
    pid: number;
  };
  error?: { code: number };
  result: {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    settings: unknown;
    capabilities: Record<string, unknown>;
  };
}

/** Stands in for the WebSocket and the Monaco client behind it. */
function fakeSocket() {
  const frames: TestFrame[] = [];
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
    frames,
    closedWith: () => close,
    untilClosed: () => until(() => close),
    untilFrame: (match: (frame: TestFrame) => boolean) => until(() => frames.find(match)),
    /** The server's pulled settings, once `count` pulls have come back. */
    untilPull: (count: number) =>
      until(() => frames.filter((frame) => frame.method === "test/pulled")[count - 1]?.params),
  };
}

/** A killed process lingers until its parent or init has collected it, which is why this waits. */
function isRunning(pid: number): boolean {
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    env: { PATH: "/bin:/usr/bin" },
  }).stdout.toString();
  return state.trim() !== "" && !state.startsWith("Z");
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(20);
}

const frameOf = (message: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", ...message });
const INITIALIZE = frameOf({ id: 1, method: "initialize", params: { capabilities: {} } });
const INITIALIZED = frameOf({ method: "initialized", params: {} });

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
    const plan = await planRustAnalyzer("/wt", toolchain, false);
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

  test("refuses a toolchain named by path from a source not known to be the user's", async () => {
    const named = { name: "/elsewhere/toolchain" };
    expect(await reasonFor(activeToolchain({ ...named, source: "unknown" }))).toContain("by path");
  });

  test("prints no command for a toolchain name that is not plain", async () => {
    const reason = await reasonFor({
      status: "not-installed",
      source: "toolchain-file",
      name: "x; touch y",
      toolchainFile: null,
    });
    expect(reason).toBe("The selected Rust toolchain is not installed.");
  });

  async function planWithVersion(version: string) {
    const { bin, root } = await installFakeRust(fakeRustAnalyzer(version));
    return planRustAnalyzer(
      await makeDir("rust-wt-"),
      activeToolchain(
        { rustcPath: join(bin, "rustc"), sysroot: root },
        { rustAnalyzer: join(bin, "rust-analyzer"), cargo: join(bin, "cargo") },
      ),
      false,
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

  test("keeps the oldest supported version in a trusted repository", async () => {
    const { bin, root } = await installFakeRust(fakeRustAnalyzer("rust-analyzer 1 (a 2020-01-01)"));
    const toolchain = activeToolchain(
      { rustcPath: join(bin, "rustc"), sysroot: root },
      { rustAnalyzer: join(bin, "rust-analyzer"), cargo: join(bin, "cargo") },
    );
    expect((await planRustAnalyzer("/wt", toolchain, true)).kind).toBe("refuse");
  });

  test("checks with clippy where the toolchain has it, which a new install changes", async () => {
    const { bin, root } = await installFakeRust();
    const tools = { rustAnalyzer: join(bin, "rust-analyzer"), cargo: join(bin, "cargo") };
    const paths = { rustcPath: join(bin, "rustc"), sysroot: root };
    const without = await planRustAnalyzer("/wt", activeToolchain(paths, tools), true);
    const withClippy = await planRustAnalyzer(
      "/wt",
      activeToolchain(paths, { ...tools, cargoClippy: join(bin, "cargo-clippy") }),
      true,
    );
    if (without.kind !== "run" || withClippy.kind !== "run") throw new Error("expected to run");
    expect(without.checkCommand).toBe("check");
    expect(withClippy.checkCommand).toBe("clippy");
    expect(withClippy.key).not.toBe(without.key);
  });

  test("starts the oldest supported version", async () => {
    const plan = await planWithVersion(`rust-analyzer 1.0.0 (abc ${MIN_RUST_ANALYZER_DATE})`);
    expect(plan.kind).toBe("run");
  });
});

describe("rustAnalyzerEnv", () => {
  test("leaves cargo's config alone in a trusted repository, and stays on the toolchain, offline", () => {
    expect(rustAnalyzerEnv(activeToolchain(), "/c/cargo", "/a:/wt/tools:/b", "/wt", true)).toEqual({
      RUSTUP_AUTO_INSTALL: "0",
      RUSTUP_TOOLCHAIN: "stable-host",
      PATH: ["/a", "/b"].join(delimiter),
      CARGO: "/c/cargo",
      CARGO_NET_OFFLINE: "true",
      CARGO_NET_GIT_FETCH_WITH_CLI: "false",
    });
  });

  test("names the compiler in a trusted repository only without a rustup toolchain", () => {
    const env = rustAnalyzerEnv(activeToolchain({ name: null }), "/c", "/a", "/wt", true);
    expect(env.RUSTC).toBe("/toolchain/bin/rustc");
    expect(env.RUSTC_WRAPPER).toBeUndefined();
  });

  test("pins the toolchain, and takes every tool setting away from cargo's config", () => {
    expect(rustAnalyzerEnv(activeToolchain(), "/c/cargo", "/a:/wt/tools:/b", "/wt", false)).toEqual(
      {
        RUSTUP_AUTO_INSTALL: "0",
        RUSTUP_TOOLCHAIN: "stable-host",
        PATH: "/a:/b",
        CARGO: "/c/cargo",
        RUSTC: "/toolchain/bin/rustc",
        RUSTC_WRAPPER: "",
        RUSTC_WORKSPACE_WRAPPER: "",
        CARGO_ENCODED_RUSTFLAGS: "",
        CARGO_ENCODED_RUSTDOCFLAGS: "",
        CARGO_TARGET_APPLIES_TO_HOST: "true",
        CARGO_UNSTABLE_HOST_CONFIG: "false",
        CARGO_NET_OFFLINE: "true",
        CARGO_NET_GIT_FETCH_WITH_CLI: "false",
      },
    );
  });

  test("names no rustup toolchain for an install without rustup", () => {
    const env = rustAnalyzerEnv(activeToolchain({ name: null }), "/c", "/a", "/wt", false);
    expect(env.RUSTUP_TOOLCHAIN).toBeUndefined();
  });
});

describe("rustAnalyzerSettings", () => {
  const RESTRICTED = {
    sysroot: "/sys",
    host: "h",
    repoTrusted: false,
    checkCommand: "check",
  } as const;
  const TRUSTED = { ...RESTRICTED, repoTrusted: true, rustSrc: true } as const;

  test("runs and checks everything in a trusted repository, in a build directory of its own", () => {
    expect(
      rustAnalyzerSettings({ ...TRUSTED, checkCommand: "clippy" }, ["/wt/Cargo.toml"]),
    ).toEqual({
      checkOnSave: true,
      check: { command: "clippy" },
      cargo: { buildScripts: { enable: true }, sysroot: "/sys", targetDir: true },
      procMacro: { enable: true },
      linkedProjects: ["/wt/Cargo.toml"],
    });
  });

  test("checks with cargo check where the toolchain has no clippy", () => {
    expect(rustAnalyzerSettings(TRUSTED, []).check).toEqual({ command: "check" });
  });

  test("names the proc macro server when no sysroot leads to it", () => {
    const { cargo, procMacro } = rustAnalyzerSettings({ ...TRUSTED, rustSrc: false }, []);
    expect(cargo).toMatchObject({ sysroot: null });
    expect(procMacro).toEqual({
      enable: true,
      server: "/sys/libexec/rust-analyzer-proc-macro-srv",
    });
  });

  test("turns off what runs project code, and lists the projects", () => {
    expect(rustAnalyzerSettings({ ...RESTRICTED, rustSrc: true }, ["/wt/Cargo.toml"])).toEqual({
      checkOnSave: false,
      cargo: { buildScripts: { enable: false }, sysroot: "/sys", target: "h" },
      procMacro: { enable: false },
      linkedProjects: ["/wt/Cargo.toml"],
    });
  });

  test("lists an empty project without a manifest, so none is looked for", () => {
    const { linkedProjects } = rustAnalyzerSettings({ ...RESTRICTED, rustSrc: true }, []);
    expect(linkedProjects).toEqual([{ sysroot: null, crates: [] }]);
  });

  test("gives files outside any package one inline project next to the manifests", () => {
    const { linkedProjects } = rustAnalyzerSettings(
      { ...RESTRICTED, rustSrc: true },
      ["/wt/Cargo.toml"],
      ["/wt/a.rs", "/wt/b.rs"],
    );
    expect(linkedProjects).toEqual([
      "/wt/Cargo.toml",
      {
        sysroot: "/sys",
        sysroot_src: "/sys/lib/rustlib/src/rust/library",
        crates: [
          { root_module: "/wt/a.rs", edition: "2024", deps: [] },
          { root_module: "/wt/b.rs", edition: "2024", deps: [] },
        ],
      },
    ]);
  });

  test("names no sysroot for those files when the toolchain has no sources", () => {
    const { linkedProjects } = rustAnalyzerSettings(
      { ...RESTRICTED, rustSrc: false },
      [],
      ["/wt/a.rs"],
    );
    expect(linkedProjects).toEqual([
      { sysroot: null, crates: [{ root_module: "/wt/a.rs", edition: "2024", deps: [] }] },
    ]);
  });
});

describe("untrustedNestedRepo", () => {
  test("finds a repository between the worktree and a manifest, unless it is trusted", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, "vendor/clone/inner/.git"), { recursive: true });
    await mkdir(join(wt, ".git"));
    const manifest = join(wt, "vendor/clone/inner/Cargo.toml");
    expect(untrustedNestedRepo(manifest, wt)).toBe(join(wt, "vendor/clone/inner"));
    setRepoTrusted(join(wt, "vendor/clone/inner"), true);
    expect(untrustedNestedRepo(manifest, wt)).toBeNull();
  });

  test("takes a submodule's `.git` file for a repository", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, "sub"));
    await writeFile(join(wt, "sub/.git"), "gitdir: ../.git/modules/sub\n");
    expect(untrustedNestedRepo(join(wt, "sub/Cargo.toml"), wt)).toBe(join(wt, "sub"));
  });

  test("finds none for the worktree's own folders", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, ".git"));
    expect(untrustedNestedRepo(join(wt, "Cargo.toml"), wt)).toBeNull();
    expect(untrustedNestedRepo(join(wt, "a/b/Cargo.toml"), wt)).toBeNull();
  });
});

describe("findRustManifests", () => {
  test("takes the worktree's own manifest alone", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, "a"));
    await writeFile(join(wt, "Cargo.toml"), "");
    await writeFile(join(wt, "a", "Cargo.toml"), "");
    expect(findRustManifests(wt, false)).toEqual([join(wt, "Cargo.toml")]);
  });

  test("takes those one directory down, and no project files", async () => {
    const wt = await makeDir("rust-wt-");
    await mkdir(join(wt, "b"));
    await mkdir(join(wt, "a", "deep"), { recursive: true });
    await writeFile(join(wt, "b", "Cargo.toml"), "");
    await writeFile(join(wt, "a", "Cargo.toml"), "");
    await writeFile(join(wt, "a", "deep", "Cargo.toml"), "");
    await writeFile(join(wt, "rust-project.json"), "{}");
    expect(findRustManifests(wt, false)).toEqual([
      join(wt, "a", "Cargo.toml"),
      join(wt, "b", "Cargo.toml"),
    ]);
  });

  test("finds nothing in a worktree without one", async () => {
    expect(findRustManifests(await makeDir("rust-wt-"), false)).toEqual([]);
  });

  test("knows which changed files can matter", () => {
    expect(isRustManifestPath("/wt", "/wt/Cargo.toml")).toBe(true);
    expect(isRustManifestPath("/wt", "/wt/a/Cargo.toml")).toBe(true);
    expect(isRustManifestPath("/wt", "/wt/a/b/Cargo.toml")).toBe(false);
    expect(isRustManifestPath("/wt", "/wt/src/main.rs")).toBe(false);
  });
});

describe("withRustClientCapabilities", () => {
  test("asks for the project status and a resolvable completion property", () => {
    const frame = withRustClientCapabilities(
      frameOf({
        id: 1,
        method: "initialize",
        params: {
          capabilities: {
            textDocument: {
              completion: {
                completionItem: { resolveSupport: { properties: ["additionalTextEdits"] } },
              },
            },
          },
        },
      }),
      false,
    );
    const { capabilities } = JSON.parse(frame).params;
    expect(capabilities.experimental.serverStatusNotification).toBe(true);
    expect(capabilities.textDocument.completion.completionItem.resolveSupport.properties).toEqual([
      "additionalTextEdits",
      "documentation",
    ]);
  });

  test("drops the client's own settings", () => {
    const frame = withRustClientCapabilities(
      frameOf({
        id: 1,
        method: "initialize",
        params: { capabilities: {}, initializationOptions: { checkOnSave: true } },
      }),
      false,
    );
    expect(JSON.parse(frame).params.initializationOptions).toBeUndefined();
  });

  test("drops the client's own settings also without capabilities", () => {
    const frame = withRustClientCapabilities(
      frameOf({ id: 1, method: "initialize", params: { initializationOptions: { a: 1 } } }),
      false,
    );
    expect(JSON.parse(frame).params.initializationOptions).toBeUndefined();
  });

  test("leaves other frames as they are", () => {
    const other = frameOf({ method: "initialized", params: {} });
    expect(withRustClientCapabilities(other, false)).toBe(other);
    expect(withRustClientCapabilities("not json initialize", true)).toBe("not json initialize");
  });
});

describe("diagnostics in a trusted repository", () => {
  const initialize = frameOf({
    id: 1,
    method: "initialize",
    params: { capabilities: { textDocument: { diagnostic: { dynamicRegistration: true } } } },
  });
  const textDocumentOf = (trusted: boolean) =>
    JSON.parse(withRustClientCapabilities(initialize, trusted)).params.capabilities.textDocument;

  test("takes pull diagnostics away from a trusted server only", () => {
    expect(textDocumentOf(true).diagnostic).toBeUndefined();
    expect(textDocumentOf(false).diagnostic).toEqual({ dynamicRegistration: true });
  });

  test("takes them out of what the server offers", () => {
    const response = frameOf({
      id: 1,
      result: { capabilities: { diagnosticProvider: { identifier: "x" }, hoverProvider: true } },
    });
    expect(JSON.parse(withoutPullDiagnostics(response)).result.capabilities).toEqual({
      hoverProvider: true,
    });
  });

  test("leaves other frames as they are", () => {
    const other = frameOf({ method: "x", params: { text: '"diagnosticProvider"' } });
    expect(withoutPullDiagnostics(other)).toBe(other);
  });
});

describe("blockedClientMethod", () => {
  test("keeps out what can start something or undo the settings", () => {
    for (const method of [
      "textDocument/didSave",
      "textDocument/formatting",
      "textDocument/rangeFormatting",
      "workspace/didChangeConfiguration",
      "workspace/executeCommand",
      "rust-analyzer/runFlycheck",
      "rust-analyzer/rebuildProcMacros",
      "experimental/runTest",
    ]) {
      expect(blockedClientMethod(frameOf({ method, params: {} }))?.method).toBe(method);
    }
  });

  test("lets editing and queries through", () => {
    for (const method of ["initialize", "textDocument/didChange", "textDocument/hover"]) {
      expect(blockedClientMethod(frameOf({ id: 1, method, params: {} }))).toBeNull();
    }
    expect(blockedClientMethod("not json")).toBeNull();
    expect(blockedClientMethod(frameOf({ id: 1, result: null }))).toBeNull();
  });
});

describe("readServerStatus", () => {
  const status = (params: Record<string, unknown>) =>
    readServerStatus(frameOf({ method: "experimental/serverStatus", params }), "/wt");

  test("says what to run for dependencies that could not be read", () => {
    const read = status({
      health: "warning",
      message: "Failed to read Cargo metadata with dependencies for `Cargo.toml`: offline",
    });
    expect(read?.notices).toHaveLength(1);
    expect(read?.notices[0]?.kind).toBe("dependencies");
    expect(read?.notices[0]?.message).toContain("cargo fetch");
  });

  test("names the folder of each project with missing dependencies", () => {
    const line = (manifest: string) =>
      `Failed to read Cargo metadata with dependencies for \`${manifest}\`: offline`;
    const read = status({
      health: "warning",
      message: [
        line("/wt/Cargo.toml"),
        line("/wt/services/alpha/Cargo.toml"),
        line("/elsewhere/Cargo.toml"),
      ].join("\n\n"),
    });
    expect(read?.notices.map((notice) => notice.kind)).toEqual([
      "dependencies",
      "dependencies:services/alpha",
      "dependencies",
    ]);
    expect(read?.notices[0]?.message).not.toContain("folder");
    expect(read?.notices[1]?.message).toContain("Some dependencies of services/alpha");
  });

  test("reports a project that does not load by its first error", () => {
    const read = status({
      health: "error",
      message: "cargo metadata failed\nerror: failed to parse manifest\nmore",
    });
    expect(read?.notices[0]?.kind).toBe("project");
    expect(read?.notices[0]?.message).toContain("error: failed to parse manifest");
  });

  test("tells nothing for other statuses, and leaves other frames alone", () => {
    expect(status({ health: "ok" })).toEqual({ notices: [] });
    expect(status({ health: "warning", message: "something else" })).toEqual({ notices: [] });
    expect(readServerStatus(frameOf({ id: 1, result: null }), "/wt")).toBeNull();
  });
});

describe("rustManifestProblem", () => {
  test("asks offline for the package alone, in the given environment, from its folder", async () => {
    const dir = await makeDir("rust-cargo-");
    const cargo = join(dir, "cargo");
    const seen = join(dir, "seen");
    await writeExecutable(
      cargo,
      `#!/bin/sh\necho "$PWD|$*|$RUSTC_WRAPPER|$CARGO_NET_OFFLINE" > "${seen}"\n`,
    );
    const crate = join(dir, "crate");
    await mkdir(crate);
    const env = { RUSTC_WRAPPER: "", CARGO_NET_OFFLINE: "true" };
    expect(await rustManifestProblem({ cargo, env }, join(crate, "Cargo.toml"))).toBeNull();
    expect((await Bun.file(seen).text()).trim()).toBe(
      `${crate}|metadata --no-deps --offline --format-version 1 --color never --manifest-path ${join(crate, "Cargo.toml")}||true`,
    );
  });

  test("gives cargo's first error, and says when cargo cannot start", async () => {
    const dir = await makeDir("rust-cargo-");
    const cargo = join(dir, "cargo");
    await writeExecutable(
      cargo,
      `#!/bin/sh\necho "warning: a" >&2\necho "error: b" >&2\nexit 101\n`,
    );
    expect(await rustManifestProblem({ cargo, env: {} }, join(dir, "Cargo.toml"))).toBe("error: b");
    expect(
      await rustManifestProblem({ cargo: join(dir, "gone"), env: {} }, join(dir, "Cargo.toml")),
    ).toBe("cargo could not be started.");
  });
});

describe("readDocumentLifecycle", () => {
  const frame = (method: string, uri: string) =>
    frameOf({ method, params: { textDocument: { uri } } });

  test("reads a Rust file opening and closing", () => {
    expect(readDocumentLifecycle(frame("textDocument/didOpen", "file:///wt/a%20b.rs"))).toEqual({
      opened: true,
      file: "/wt/a b.rs",
    });
    expect(readDocumentLifecycle(frame("textDocument/didClose", "file:///wt/a.rs"))).toEqual({
      opened: false,
      file: "/wt/a.rs",
    });
  });

  test("ignores everything else", () => {
    expect(
      readDocumentLifecycle(frame("textDocument/didOpen", "file:///wt/Cargo.toml")),
    ).toBeNull();
    expect(readDocumentLifecycle(frame("textDocument/didOpen", "untitled:/a.rs"))).toBeNull();
    expect(readDocumentLifecycle(frame("textDocument/hover", "file:///wt/a.rs"))).toBeNull();
    expect(readDocumentLifecycle("not json")).toBeNull();
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

  const open = (socket: ReturnType<typeof fakeSocket>, file: string) =>
    manager?.handleMessage(
      socket.ws,
      frameOf({
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri: `file://${file}`, languageId: "rust", version: 1, text: "" },
        },
      }),
    );

  /** A crate of its own at `dir` under the worktree, with one source file, whose path is returned. */
  async function makeCrate(wt: string, dir: string, manifest = "[package]\nname = 'x'\n") {
    await mkdir(join(wt, dir, "src"), { recursive: true });
    await writeFile(join(wt, dir, "Cargo.toml"), manifest);
    const file = join(wt, dir, "src", "lib.rs");
    await writeFile(file, "");
    return file;
  }

  describe("projects of opened files", () => {
    async function started(wt: string) {
      const socket = await start(wt);
      await socket.untilFrame((message) => message.id === 1);
      manager?.handleMessage(socket.ws, INITIALIZED);
      return socket;
    }

    test("adds a nested crate through the server's pull, with the restricted settings", async () => {
      const { root } = await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const socket = await started(wt);
      open(socket, await makeCrate(wt, "services/alpha/rust"));

      const { settings } = await socket.untilPull(1);
      expect(settings).toEqual({
        checkOnSave: false,
        cargo: { buildScripts: { enable: false }, sysroot: root, target: "fake-host-triple" },
        procMacro: { enable: false },
        linkedProjects: [join(wt, "services/alpha/rust/Cargo.toml")],
      });
      expect(socket.closedWith()).toBeUndefined();
    });

    test("adds to what the start found, and asks once for a known project", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "Cargo.toml"), "[workspace]\nmembers = ['crates/*']\n");
      const member = await makeCrate(wt, "crates/one");
      const fuzz = await makeCrate(wt, "fuzz");
      const socket = await started(wt);
      open(socket, member);
      open(socket, fuzz);
      open(socket, fuzz);
      const { settings } = await socket.untilPull(1);
      expect(settings.linkedProjects).toEqual([
        join(wt, "Cargo.toml"),
        join(wt, "fuzz/Cargo.toml"),
      ]);

      // The sentinel is the second pull, so a stray one for the member or the repeat would show.
      open(socket, await makeCrate(wt, "other"));
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        join(wt, "Cargo.toml"),
        join(wt, "fuzz/Cargo.toml"),
        join(wt, "other/Cargo.toml"),
      ]);
    });

    test("adds nothing for a file outside the worktree", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const outside = await makeDir("rust-outside-");
      const socket = await started(wt);
      open(socket, await makeCrate(outside, "std"));
      open(socket, await makeCrate(wt, "mine"));
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "mine/Cargo.toml"),
      ]);
    });

    test("gives a file outside any package the inline project", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const loose = join(wt, "scratch.rs");
      await writeFile(loose, "");
      const socket = await started(wt);
      open(socket, loose);
      const [project] = (await socket.untilPull(1)).settings.linkedProjects;
      expect(project).toMatchObject({ crates: [{ root_module: loose, edition: "2024" }] });
    });

    test("leaves out a project cargo cannot read, says why, and tries again after a change", async () => {
      const { bin } = await installFakeRust();
      await writeExecutable(
        join(bin, "cargo"),
        `#!/bin/sh
read -r first < "$PWD/Cargo.toml"
if [ "$first" = "[package" ]; then
  echo "warning: x" >&2
  echo "error: failed to parse manifest" >&2
  exit 101
fi
`,
      );
      const wt = await makeDir("rust-wt-");
      const file = await makeCrate(wt, "deep/broken", "[package\n");
      const socket = await started(wt);
      open(socket, file);
      const { params } = await socket.untilFrame(
        (message) =>
          message.method === "window/showMessage" && message.params.message.includes("broken"),
      );
      expect(params.message).toBe(
        "Could not load the Rust project in deep/broken. error: failed to parse manifest",
      );

      open(socket, await makeCrate(wt, "deep/fine"));
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "deep/fine/Cargo.toml"),
      ]);

      await writeFile(join(wt, "deep/broken/Cargo.toml"), "[package]\nname = 'broken'\n");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "deep/broken/Cargo.toml")]);
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        join(wt, "deep/fine/Cargo.toml"),
        join(wt, "deep/broken/Cargo.toml"),
      ]);
    });

    /** Fails while a manifest's first line is `[package`, as for broken TOML. */
    const CARGO_FAILS_ON_BROKEN = `#!/bin/sh
read -r first < "$PWD/Cargo.toml"
if [ "$first" = "[package" ]; then
  echo "error: failed to parse manifest" >&2
  exit 101
fi
`;

    test("keeps a broken manifest from the start out, so others can load", async () => {
      const { bin } = await installFakeRust();
      await writeExecutable(join(bin, "cargo"), CARGO_FAILS_ON_BROKEN);
      const wt = await makeDir("rust-wt-");
      await makeCrate(wt, "bad", "[package\n");
      const socket = await started(wt);
      open(socket, await makeCrate(wt, "deep/fine"));
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "deep/fine/Cargo.toml"),
      ]);
      await socket.untilFrame(
        (message) =>
          message.method === "window/showMessage" &&
          message.params.message.startsWith("Could not load the Rust project in bad."),
      );

      await writeFile(join(wt, "bad/Cargo.toml"), "[package]\nname = 'bad'\n");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "bad/Cargo.toml")]);
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        join(wt, "bad/Cargo.toml"),
        join(wt, "deep/fine/Cargo.toml"),
      ]);
    });

    test("forgets a refused manifest once it is gone", async () => {
      const { bin } = await installFakeRust();
      await writeExecutable(join(bin, "cargo"), CARGO_FAILS_ON_BROKEN);
      const wt = await makeDir("rust-wt-");
      const file = await makeCrate(wt, "deep/broken", "[package\n");
      const socket = await started(wt);
      open(socket, file);
      const isNotice = (message: { method?: string; params: { message: string } }) =>
        message.method === "window/showMessage" && message.params.message.includes("deep/broken");
      await socket.untilFrame(isNotice);

      await rm(join(wt, "deep/broken"), { recursive: true });
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "deep/broken/Cargo.toml")]);
      // Adding this project is the sentinel: the change before it has been dealt with by then.
      open(socket, await makeCrate(wt, "deep/other"));
      await socket.untilPull(1);
      await writeFile(join(wt, "deep/other/Cargo.toml"), "[package]\nname = 'other'\n");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "deep/other/Cargo.toml")]);
      open(socket, await makeCrate(wt, "deep/third"));
      await socket.untilPull(2);
      expect(socket.frames.filter(isNotice)).toHaveLength(1);
    });

    test("says which loaded manifest broke, and keeps it linked", async () => {
      const { bin } = await installFakeRust();
      await writeExecutable(join(bin, "cargo"), CARGO_FAILS_ON_BROKEN);
      const wt = await makeDir("rust-wt-");
      const socket = await started(wt);
      open(socket, await makeCrate(wt, "deep/one"));
      await socket.untilPull(1);

      await writeFile(join(wt, "deep/one/Cargo.toml"), "[package\n");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "deep/one/Cargo.toml")]);
      await socket.untilFrame(
        (message) =>
          message.method === "window/showMessage" &&
          message.params.message.startsWith("Could not load the Rust project in deep/one."),
      );
      open(socket, await makeCrate(wt, "deep/two"));
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        join(wt, "deep/one/Cargo.toml"),
        join(wt, "deep/two/Cargo.toml"),
      ]);
    });

    test("takes a fix made while the check of the broken text is running", async () => {
      const { bin } = await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const release = join(wt, "release");
      const running = join(wt, "running");
      // The first check reports the text it read before the fix; later ones read the file anew.
      await writeExecutable(
        join(bin, "cargo"),
        `#!/bin/sh
case "$PWD" in *broken*) ;; *) exit 0 ;; esac
if [ ! -e "${release}" ]; then
  : > "${running}"
  until [ -e "${release}" ]; do :; done
  echo "error: failed to parse manifest" >&2
  exit 101
fi
`,
      );
      const file = await makeCrate(wt, "deep/broken", "[package\n");
      const socket = await started(wt);
      open(socket, file);
      while (!(await Bun.file(running).exists())) await Bun.sleep(1);

      await writeFile(join(wt, "deep/broken/Cargo.toml"), "[package]\nname = 'x'\n");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "deep/broken/Cargo.toml")]);
      await writeFile(release, "");
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "deep/broken/Cargo.toml"),
      ]);
    });

    test("notices a manifest in an ignored folder, and not one in a build", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await mkdir(join(wt, "a/b/src"), { recursive: true });
      const file = join(wt, "a/b/src/lib.rs");
      await writeFile(file, "");
      const socket = await started(wt);
      open(socket, file);
      await socket.untilPull(1);

      manager?.notifyIgnoredPathChanged(wt, "target/package/x/Cargo.toml");
      await writeFile(join(wt, "a/b/Cargo.toml"), "[package]\nname = 'b'\n");
      manager?.notifyIgnoredPathChanged(wt, "a/b/Cargo.toml");
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        join(wt, "a/b/Cargo.toml"),
      ]);
    });

    test("brings back a loose file deleted and written again while open", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const file = join(wt, "scratch.rs");
      await writeFile(file, "");
      const socket = await started(wt);
      open(socket, file);
      await socket.untilPull(1);

      await rm(file);
      manager?.notifyWatchedFilesChanged(wt, [file]);
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        { sysroot: null, crates: [] },
      ]);
      await writeFile(file, "");
      manager?.notifyWatchedFilesChanged(wt, [file]);
      const [project] = (await socket.untilPull(3)).settings.linkedProjects;
      expect(project).toMatchObject({ crates: [{ root_module: file }] });
    });

    test("counts loose files as one project, and drops closed ones", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const socket = await started(wt);
      const files = [join(wt, "one.rs"), join(wt, "two.rs")];
      await Promise.all(files.map((file) => writeFile(file, "")));
      open(socket, files[0] ?? "");
      await socket.untilPull(1);
      manager?.handleMessage(
        socket.ws,
        frameOf({
          method: "textDocument/didClose",
          params: { textDocument: { uri: `file://${files[0]}` } },
        }),
      );
      open(socket, files[1] ?? "");
      const [project] = (await socket.untilPull(2)).settings.linkedProjects;
      expect(project).toMatchObject({ crates: [{ root_module: files[1] }] });
      for (let i = 0; i < MAX_OPENED_RUST_PROJECTS - 1; i++) {
        open(socket, await makeCrate(wt, `deep/crate${i}`));
      }
      const full = MAX_OPENED_RUST_PROJECTS;
      await socket.untilFrame(
        (message) =>
          message.method === "test/pulled" &&
          message.params.settings.linkedProjects.length === full,
      );
      expect(socket.frames.some((frame) => frame.params?.message?.includes("at most"))).toBe(false);
    });

    test("drops a deleted manifest without a restart, and the file falls to what remains", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const file = await makeCrate(wt, "a/b/c");
      const socket = await started(wt);
      open(socket, file);
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "a/b/c/Cargo.toml"),
      ]);

      await rm(join(wt, "a/b/c/Cargo.toml"));
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "a/b/c/Cargo.toml")]);
      const [project] = (await socket.untilPull(2)).settings.linkedProjects;
      expect(project).toMatchObject({ crates: [{ root_module: file }] });
      expect(socket.closedWith()).toBeUndefined();
    });

    test("moves a loose file to the project that appears around it", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await mkdir(join(wt, "a/b/src"), { recursive: true });
      const file = join(wt, "a/b/src/lib.rs");
      await writeFile(file, "");
      const socket = await started(wt);
      open(socket, file);
      await socket.untilPull(1);

      await writeFile(join(wt, "a/b/Cargo.toml"), "[package]\nname = 'b'\n");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "a/b/Cargo.toml")]);
      expect((await socket.untilPull(2)).settings.linkedProjects).toEqual([
        join(wt, "a/b/Cargo.toml"),
      ]);
    });

    test("says so at the limit, and keeps what is loaded", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const socket = await started(wt);
      for (let i = 0; i <= MAX_OPENED_RUST_PROJECTS; i++) {
        open(socket, await makeCrate(wt, `deep/crate${i}`));
      }
      const { params } = await socket.untilFrame(
        (message) =>
          message.method === "window/showMessage" && message.params.message.includes("at most"),
      );
      expect(params.message).toContain(`at most ${MAX_OPENED_RUST_PROJECTS}`);
      expect(params.message).toContain(`deep/crate${MAX_OPENED_RUST_PROJECTS}/src/lib.rs`);
      await socket.untilFrame(
        (message) =>
          message.method === "test/pulled" &&
          message.params.settings.linkedProjects.length === MAX_OPENED_RUST_PROJECTS,
      );
      const pulled = socket.frames.filter((frame) => frame.method === "test/pulled");
      for (const { params: pull } of pulled) {
        expect(pull.settings.linkedProjects.length).toBeLessThanOrEqual(MAX_OPENED_RUST_PROJECTS);
      }
    });

    test("starts over after a restart, from what the client opens again", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const file = await makeCrate(wt, "a/b");
      const first = await started(wt);
      open(first, file);
      await first.untilPull(1);

      await writeFile(join(wt, "Cargo.toml"), "");
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "Cargo.toml")]);
      expect(first.closedWith()?.code).toBe(LSP_RESTART_CLOSE_CODE);
      const second = fakeSocket();
      manager?.createSession(second.ws, wt);
      manager?.handleMessage(second.ws, INITIALIZE);
      const { result } = await second.untilFrame((message) => message.id === 1);
      expect(result.settings).toMatchObject({ linkedProjects: [join(wt, "Cargo.toml")] });
      manager?.handleMessage(second.ws, INITIALIZED);
      open(second, file);
      expect((await second.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "Cargo.toml"),
        join(wt, "a/b/Cargo.toml"),
      ]);
      expect(second.closedWith()).toBeUndefined();
    });
  });

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
    expect(Object.keys(result.capabilities).toSorted()).toEqual([
      "diagnosticProvider",
      "hoverProvider",
    ]);
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
    await installFakeRust(undefined, { rustSrc: false });
    const socket = await start(await makeDir("rust-wt-"));
    await socket.untilFrame((message) => message.id === 1);
    manager?.handleMessage(socket.ws, INITIALIZED);
    const { params } = await socket.untilFrame(
      (message) =>
        message.method === "window/showMessage" && message.params.message.includes("rust-src"),
    );
    expect(params.message).toContain("rustup component add rust-src");
  });

  test("takes the project status out, and tells what it reports once", async () => {
    await installFakeRust();
    const wt = await makeDir("rust-wt-");
    await writeFile(join(wt, "Cargo.toml"), "");
    const socket = await start(wt);
    await socket.untilFrame((message) => message.method === "test/after-status");
    expect(socket.frames.some((message) => message.method === "experimental/serverStatus")).toBe(
      false,
    );
    const shown = socket.frames.filter((message) => message.method === "window/showMessage");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.params.message).toContain("cargo fetch");
  });

  test("restarts when the worktree's manifests change, and not for other files", async () => {
    await installFakeRust();
    const wt = await makeDir("rust-wt-");
    const socket = await start(wt);
    await socket.untilFrame((message) => message.id === 1);

    manager?.notifyWatchedFilesChanged(wt, [join(wt, "Cargo.toml")]);
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "src", "main.rs")]);
    expect(socket.closedWith()).toBeUndefined();
    await writeFile(join(wt, "Cargo.toml"), "");
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "Cargo.toml")]);
    expect(socket.closedWith()?.code).toBe(LSP_RESTART_CLOSE_CODE);
  });

  test("answers a blocked request itself, without the server", async () => {
    await installFakeRust();
    const wt = await makeDir("rust-wt-");
    const socket = await start(wt);
    await socket.untilFrame((message) => message.id === 1);
    manager?.handleMessage(
      socket.ws,
      frameOf({ id: 7, method: "textDocument/formatting", params: {} }),
    );
    const answer = await socket.untilFrame((message) => message.id === 7);
    expect(answer.error?.code).toBe(-32601);
  });

  test("restarts when the toolchain no longer offers what runs", async () => {
    const { bin } = await installFakeRust();
    const wt = await makeDir("rust-wt-");
    const socket = await start(wt);
    await socket.untilFrame((message) => message.id === 1);
    await rm(join(bin, "rust-analyzer"));
    refreshRustToolchain(wt);
    const closed = await socket.untilClosed();
    expect(closed.code).toBe(LSP_RESTART_CLOSE_CODE);
  });

  describe("in a trusted repository", () => {
    const stateOf = (socket: ReturnType<typeof fakeSocket>) => {
      const session = manager?.["sessions"].get(socket.ws);
      return session && manager?.["states"].get(session);
    };

    async function startedIn(wt: string) {
      const socket = await start(wt);
      await socket.untilFrame((message) => message.id === 1);
      manager?.handleMessage(socket.ws, INITIALIZED);
      return socket;
    }

    /** A folder of the worktree that is a repository of its own, holding a crate. */
    async function makeNestedRepo(wt: string, dir: string) {
      const file = await makeCrate(wt, dir);
      await mkdir(join(wt, dir, ".git"));
      return file;
    }

    test("runs everything, and takes pull diagnostics away", async () => {
      const { root } = await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "Cargo.toml"), "");
      setRepoTrusted(wt, true);
      const socket = await start(wt);

      const { result } = await socket.untilFrame((message) => message.id === 1);
      expect(result.settings).toEqual({
        checkOnSave: true,
        check: { command: "check" },
        cargo: { buildScripts: { enable: true }, sysroot: root, targetDir: true },
        procMacro: { enable: true },
        linkedProjects: [join(wt, "Cargo.toml")],
      });
      expect(result.env.RUSTC_WRAPPER).toBeUndefined();
      expect(result.env.CARGO_NET_OFFLINE).toBe("true");
      expect(Object.keys(result.capabilities)).toEqual(["hoverProvider"]);
    });

    test("restarts by itself when the answer changes", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "Cargo.toml"), "");
      const socket = await startedIn(wt);
      setRepoTrusted(wt, true);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("asks only once a Cargo project is linked, and not for a loose file", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "loose.rs"), "");
      const socket = await startedIn(wt);
      open(socket, join(wt, "loose.rs"));
      await socket.untilPull(1);
      expect(getRepoTrustStatus(wt).restrictions).toEqual([]);

      open(socket, await makeCrate(wt, "crate"));
      await socket.untilPull(2);
      expect(getRepoTrustStatus(wt).restrictions).toHaveLength(1);
    });

    test("saves a changed file that is not open, once per project", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const lib = await makeCrate(wt, "");
      setRepoTrusted(wt, true);
      const socket = await startedIn(wt);
      await writeFile(join(wt, "src/other.rs"), "");
      manager?.notifyWatchedFilesChanged(wt, [lib, join(wt, "src/other.rs")]);
      const saved = await socket.untilFrame((message) => message.method === "test/saved");
      expect(saved.params.uri).toBe(`file://${lib}`);
      // In order behind any second save of that batch.
      manager?.handleMessage(socket.ws, frameOf({ method: "test/ping", params: {} }));
      await socket.untilFrame((message) => message.method === "test/pong");
      expect(socket.frames.filter((message) => message.method === "test/saved")).toHaveLength(1);
    });

    test("saves nothing before the client's initialized", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const lib = await makeCrate(wt, "");
      setRepoTrusted(wt, true);
      const socket = await start(wt);
      await socket.untilFrame((message) => message.id === 1);
      const checks = stateOf(socket)?.checks;
      jest.useFakeTimers();
      manager?.notifyWatchedFilesChanged(wt, [lib]);
      jest.advanceTimersByTime(CHECK_QUIET_MS);
      jest.useRealTimers();
      await checks?.idle();
      manager?.handleMessage(socket.ws, frameOf({ method: "test/ping", params: {} }));
      await socket.untilFrame((message) => message.method === "test/pong");
      expect(socket.frames.some((message) => message.method === "test/saved")).toBe(false);
    });

    test("saves a crate that is not linked through the linked project above it", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await makeCrate(wt, "");
      const dep = await makeCrate(wt, "dep");
      setRepoTrusted(wt, true);
      const socket = await startedIn(wt);
      manager?.notifyWatchedFilesChanged(wt, [dep]);
      const saved = await socket.untilFrame((message) => message.method === "test/saved");
      expect(saved.params.uri).toBe(`file://${dep}`);
    });

    test("restarts when a linked folder has become an untrusted repository", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "Cargo.toml"), "");
      const nested = await makeCrate(wt, "a/b");
      setRepoTrusted(wt, true);
      const socket = await startedIn(wt);
      open(socket, nested);
      await socket.untilPull(1);
      await mkdir(join(wt, "a/b/.git"));
      manager?.notifyWatchedFilesChanged(wt, [join(wt, "a/b/Cargo.toml")]);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("starts no check in an untrusted repository, and still refuses the client's save", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await makeCrate(wt, "");
      const socket = await startedIn(wt);
      expect(stateOf(socket)?.checks).toBeNull();
      expect(blockedClientMethod(frameOf({ method: "textDocument/didSave" }))).not.toBeNull();
    });

    test("leaves out an untrusted repository in the worktree, and tells when its file opens", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await makeNestedRepo(wt, "theirs");
      const nested = await makeNestedRepo(wt, "vendor/clone");
      await makeCrate(wt, "mine");
      setRepoTrusted(wt, true);
      const socket = await startedIn(wt);
      expect(stateOf(socket)?.manifests).toEqual([join(wt, "mine/Cargo.toml")]);

      open(socket, nested);
      const notice = await socket.untilFrame(
        (message) =>
          message.method === "window/showMessage" && message.params.message.includes("repository"),
      );
      expect(notice.params.message).toContain(join("vendor", "clone"));
      open(socket, await makeCrate(wt, "other"));
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "mine/Cargo.toml"),
        join(wt, "other/Cargo.toml"),
      ]);
    });

    test("loads a nested repository trusted on its own, and restarts when that ends", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "Cargo.toml"), "");
      const nested = await makeNestedRepo(wt, "vendor/clone");
      setRepoTrusted(wt, true);
      setRepoTrusted(join(wt, "vendor/clone"), true);
      const socket = await startedIn(wt);
      open(socket, nested);
      expect((await socket.untilPull(1)).settings.linkedProjects).toContain(
        join(wt, "vendor/clone/Cargo.toml"),
      );
      setRepoTrusted(join(wt, "vendor/clone"), false);
      expect((await socket.untilClosed()).code).toBe(LSP_RESTART_CLOSE_CODE);
    });

    test("restricted, a nested repository's manifest links as before", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      const nested = await makeNestedRepo(wt, "vendor/clone");
      const socket = await startedIn(wt);
      open(socket, nested);
      expect((await socket.untilPull(1)).settings.linkedProjects).toEqual([
        join(wt, "vendor/clone/Cargo.toml"),
      ]);
    });

    test("ends what the server started when it stops", async () => {
      await installFakeRust();
      const wt = await makeDir("rust-wt-");
      await writeFile(join(wt, "Cargo.toml"), "");
      setRepoTrusted(wt, true);
      const socket = await startedIn(wt);
      manager?.handleMessage(socket.ws, frameOf({ method: "test/startChild", params: {} }));
      const started = await socket.untilFrame((message) => message.method === "test/childStarted");
      const { pid } = started.params;
      expect(isRunning(pid)).toBe(true);
      manager?.destroySession(socket.ws);
      await until(() => !isRunning(pid));
    });
  });
});
