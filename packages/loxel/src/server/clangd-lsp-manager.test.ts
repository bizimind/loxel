import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { LSP_START_FAILED_CLOSE_CODE } from "@/api/ws-protocol";

import {
  checkClangd,
  clangdMajorVersion,
  ClangdLspManager,
  prepareClangdUserConfig,
  queryDriverGlobs,
} from "./clangd-lsp-manager";

const CLANGD = Bun.which("clangd");
const TEST_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
let manager: ClangdLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  // The killed server's index may still be finishing a write into the project.
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 })),
  );
});

/** A fresh directory whose path has a space in it, as a user's project may. */
async function makeDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "clangd lsp-")));
  dirs.push(dir);
  return dir;
}

/** Just enough of a language client to start the server and wait for a file's diagnostics. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  closed: { code?: number; reason?: string } | undefined;
  private nextId = 1;
  private readonly responses = new Map<number, (result: unknown) => void>();
  private readonly diagnosticsWaiters = new Map<string, (diagnostics: unknown[]) => void>();

  constructor(private readonly server: ClangdLspManager) {
    const ws = {
      send: (data: string) => {
        this.receive(data);
        return data.length;
      },
      close: (code?: number, reason?: string) => {
        this.closed = { code, reason };
      },
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  async start(wtPath: string): Promise<{ capabilities: Record<string, unknown> }> {
    this.server.createSession(this.ws, wtPath);
    const result = await this.request("initialize", { processId: null, capabilities: {} });
    this.send({ method: "initialized", params: {} });
    return result as { capabilities: Record<string, unknown> };
  }

  /** Open a file and wait until clangd has built it and sent its diagnostics. */
  async openAndWaitForDiagnostics(file: string): Promise<unknown[]> {
    const uri = pathToFileURL(file).href;
    const published = new Promise<unknown[]>((resolve) => {
      this.diagnosticsWaiters.set(uri, resolve);
    });
    const text = await readFile(file, "utf8");
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "cpp", version: 1, text } },
    });
    return published;
  }

  /** Ask clangd to shut down, and wait for its answer. */
  async shutdown(): Promise<void> {
    await this.request("shutdown", null);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.responses.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.server.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(data: string): void {
    const message = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: { uri?: string; diagnostics?: unknown[] };
      result?: unknown;
    };
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
      this.diagnosticsWaiters.get(message.params.uri)?.(message.params.diagnostics ?? []);
      return;
    }
    if (message.id !== undefined && !message.method) {
      this.responses.get(message.id)?.(message.result);
    }
  }
}

describe("queryDriverGlobs", () => {
  test("names compilers in the given directories and nothing broader", () => {
    const globs = queryDriverGlobs(["/usr/bin"]).split(",");
    expect(globs).toEqual(["/usr/bin/*gcc*", "/usr/bin/*g++*", "/usr/bin/*clang*"]);
    for (const glob of queryDriverGlobs().split(",")) {
      expect(glob).not.toContain("**");
      expect(glob).not.toMatch(/\/\*$/);
      expect(glob).toMatch(/^\/(usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)\//);
    }
  });
});

describe("prepareClangdUserConfig", () => {
  test("uses HOME on macOS and starts the file with its own document, the user's after it", async () => {
    const state = await makeDir();
    const home = await makeDir();
    const userConfig = join(home, "Library", "Preferences", "clangd");
    await mkdir(userConfig, { recursive: true });
    await writeFile(join(userConfig, "config.yaml"), "Diagnostics:\n  UnusedIncludes: None\n");

    const env = prepareClangdUserConfig(state, "darwin", { HOME: home });

    expect(Object.keys(env)).toEqual(["HOME"]);
    const written = await readFile(
      join(env.HOME!, "Library", "Preferences", "clangd", "config.yaml"),
      "utf8",
    );
    expect(written.startsWith("CompileFlags:\n  Remove:")).toBe(true);
    expect(written.endsWith("...\nDiagnostics:\n  UnusedIncludes: None\n")).toBe(true);
  });

  test("uses XDG_CONFIG_HOME on Linux and reads the user's from where it is set", async () => {
    const state = await makeDir();
    const userXdg = await makeDir();
    await mkdir(join(userXdg, "clangd"));
    await writeFile(join(userXdg, "clangd", "config.yaml"), "InlayHints:\n  Enabled: No\n");

    const env = prepareClangdUserConfig(state, "linux", {
      HOME: await makeDir(),
      XDG_CONFIG_HOME: userXdg,
    });

    expect(Object.keys(env)).toEqual(["XDG_CONFIG_HOME"]);
    const written = await readFile(join(env.XDG_CONFIG_HOME!, "clangd", "config.yaml"), "utf8");
    expect(written.endsWith("...\nInlayHints:\n  Enabled: No\n")).toBe(true);
  });

  test("picks up edits to the user's config at the next start", async () => {
    const state = await makeDir();
    const home = await makeDir();
    await mkdir(join(home, ".config", "clangd"), { recursive: true });
    const userConfig = join(home, ".config", "clangd", "config.yaml");

    const env = prepareClangdUserConfig(state, "linux", { HOME: home });
    const target = join(env.XDG_CONFIG_HOME!, "clangd", "config.yaml");
    expect((await readFile(target, "utf8")).endsWith("...\n")).toBe(true);

    await writeFile(userConfig, "InlayHints:\n  Enabled: No\n");
    prepareClangdUserConfig(state, "linux", { HOME: home });
    expect((await readFile(target, "utf8")).endsWith("Enabled: No\n")).toBe(true);
  });

  test("fails when the file cannot be written", async () => {
    const state = await makeDir();
    await writeFile(join(state, "clangd-config"), "a file where the directory would go");
    expect(() => prepareClangdUserConfig(state, "linux", { HOME: state })).toThrow();
  });
});

describe("checkClangd", () => {
  const VERSION_OUTPUT = (version: string) => `clangd version ${version} (https://example)\n`;

  test("reads LLVM's and Apple's version lines", () => {
    expect(clangdMajorVersion(VERSION_OUTPUT("23.1.0"))).toBe(23);
    expect(clangdMajorVersion("Apple clangd version 21.0.0 (clang-2100.1.1.101)\n")).toBe(21);
    expect(clangdMajorVersion("something else")).toBeNull();
  });

  test("takes version 16 and newer, and one it can't read", async () => {
    const answering = (stdout: string) => async () => ({ code: 0, stdout });
    const check = (stdout: string) => checkClangd("/opt/clangd", "linux", answering(stdout));
    expect(await check(VERSION_OUTPUT("15.0.6"))).toBe("too-old");
    expect(await check(VERSION_OUTPUT("16.0.2"))).toBe("ok");
    expect(await check("")).toBe("ok");
  });

  test("does not run Apple's stub without the developer tools", async () => {
    const commands: string[][] = [];
    const check = await checkClangd("/usr/bin/clangd", "darwin", async (command) => {
      commands.push(command);
      return { code: 2, stdout: "" };
    });
    expect(check).toBe("not-installed");
    expect(commands).toEqual([["/usr/bin/xcode-select", "-p"]]);
  });

  test("runs other clangds without asking about the developer tools", async () => {
    const commands: string[][] = [];
    await checkClangd("/opt/homebrew/bin/clangd", "darwin", async (command) => {
      commands.push(command);
      return { code: 0, stdout: VERSION_OUTPUT("20.1.0") };
    });
    expect(commands).toEqual([["/opt/homebrew/bin/clangd", "--version"]]);
  });
});

describe("ClangdLspManager", () => {
  test("does not start on Windows, and says so", async () => {
    manager = new ClangdLspManager("win32", await makeDir());
    const client = new FakeClient(manager);
    manager.createSession(client.ws, await makeDir());
    expect(client.closed).toEqual({
      code: LSP_START_FAILED_CLOSE_CODE,
      reason: "clangd is not available on Windows yet",
    });
  });
});

/** A project whose compile database runs `compiler` for `x.cpp`, with `flags` before the file. */
async function writeProject(
  root: string,
  compiler: string,
  flags: readonly string[] = [],
): Promise<string> {
  const file = join(root, "x.cpp");
  await writeFile(file, "int x = 1;\n");
  const entry = { directory: root, file, arguments: [compiler, ...flags, "-c", "x.cpp"] };
  await writeFile(join(root, "compile_commands.json"), JSON.stringify([entry]));
  return file;
}

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

describe.skipIf(!CLANGD || process.platform === "win32")("ClangdLspManager with clangd", () => {
  async function runClangd(root: string, file: string): Promise<void> {
    manager?.destroy();
    manager = new ClangdLspManager(process.platform, await makeDir());
    const client = new FakeClient(manager);
    await client.start(root);
    await client.openAndWaitForDiagnostics(file);
    await client.shutdown();
  }

  test(
    "leaves formatting to format on save",
    async () => {
      const root = await makeDir();
      await writeProject(root, "/usr/bin/c++");
      manager = new ClangdLspManager(process.platform, await makeDir());
      const { capabilities } = await new FakeClient(manager).start(root);
      expect(capabilities.documentFormattingProvider).toBeUndefined();
      expect(capabilities.documentRangeFormattingProvider).toBeUndefined();
      expect(capabilities.semanticTokensProvider).toBeDefined();
      expect(capabilities.hoverProvider).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  describe("validates compile flags from project configuration", () => {
    /** The flags under test, each given the path `written` as its output. */
    const flagsWriting = (written: string): readonly (readonly string[])[] => [
      ["--serialize-diagnostics", written],
      ["-Xclang", "-serialize-diagnostic-file", "-Xclang", written],
      ["-Xclang", "-diagnostic-log-file", "-Xclang", written],
      [`-Wp,-serialize-diagnostic-file,${written}`],
      ["-MJ", written],
      ["-gen-cdb-fragment-path", written],
    ];

    test(
      "from a compile database",
      async () => {
        for (let index = 0; index < flagsWriting("").length; index++) {
          const root = await makeDir();
          const written = join(root, "written");
          const file = await writeProject(root, "/usr/bin/c++", flagsWriting(written)[index]);
          await runClangd(root, file);
          expect(await exists(written)).toBe(false);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "from a response file",
      async () => {
        const root = await makeDir();
        const written = join(root, "written");
        await writeFile(join(root, "flags.rsp"), `--serialize-diagnostics "${written}"\n`);
        const file = await writeProject(root, "/usr/bin/c++", ["@flags.rsp"]);
        await runClangd(root, file);
        expect(await exists(written)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "from compile_flags.txt",
      async () => {
        const root = await makeDir();
        const written = join(root, "written");
        const file = join(root, "x.cpp");
        await writeFile(file, "int x = 1;\n");
        await writeFile(join(root, "compile_flags.txt"), `--serialize-diagnostics\n${written}\n`);
        await runClangd(root, file);
        expect(await exists(written)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "from .clangd",
      async () => {
        const root = await makeDir();
        const written = join(root, "written");
        const file = await writeProject(root, "/usr/bin/c++");
        await writeFile(
          join(root, ".clangd"),
          `CompileFlags:\n  Add: ["--serialize-diagnostics", "${written}"]\n`,
        );
        await runClangd(root, file);
        expect(await exists(written)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "from a config file beside the compiler, or one named by a flag",
      async () => {
        const root = await makeDir();
        const written = join(root, "written");
        await writeFile(join(root, "clang++.cfg"), `--serialize-diagnostics "${written}"\n`);
        await writeFile(join(root, "clang++"), "#!/bin/sh\n");
        await chmod(join(root, "clang++"), 0o755);
        const beside = await writeProject(root, join(root, "clang++"));
        await runClangd(root, beside);
        expect(await exists(written)).toBe(false);

        const named = await writeProject(root, "/usr/bin/c++", [
          `--config=${join(root, "clang++.cfg")}`,
        ]);
        await runClangd(root, named);
        expect(await exists(written)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "and keeps the flags a project needs",
      async () => {
        const root = await makeDir();
        const file = join(root, "x.cpp");
        await writeFile(file, "int x = MISSING;\n");
        await writeFile(join(root, "compile_flags.txt"), "-DMISSING=1\n--serialize-diagnostics\n");
        manager = new ClangdLspManager(process.platform, await makeDir());
        const client = new FakeClient(manager);
        await client.start(root);
        expect(await client.openAndWaitForDiagnostics(file)).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  test(
    "applies the user's own clangd config, even a broken one, and shows no error without one",
    async () => {
      const home = await makeDir();
      const userConfig = join(
        home,
        ...(process.platform === "darwin"
          ? ["Library", "Preferences", "clangd"]
          : [".config", "clangd"]),
      );
      await mkdir(userConfig, { recursive: true });
      const { HOME, XDG_CONFIG_HOME } = process.env;
      process.env.HOME = home;
      delete process.env.XDG_CONFIG_HOME;
      try {
        const root = await makeDir();
        const written = join(root, "written");
        const file = await writeProject(root, "/usr/bin/c++", ["--serialize-diagnostics", written]);
        await writeFile(file, "int x = FROM_USER;\n");
        const open = async (): Promise<unknown[]> => {
          manager?.destroy();
          manager = new ClangdLspManager(process.platform, await makeDir());
          const client = new FakeClient(manager);
          await client.start(root);
          return client.openAndWaitForDiagnostics(file);
        };

        // Only the code's own error: an empty user config does not count as a config error.
        const undefinedName = await open();
        expect(JSON.stringify(undefinedName)).toContain("FROM_USER");
        expect(JSON.stringify(undefinedName)).not.toContain("clangd-config");

        await writeFile(
          join(userConfig, "config.yaml"),
          'CompileFlags:\n  Add: ["-DFROM_USER=1"]\n',
        );
        expect(await open()).toEqual([]);

        await writeFile(join(userConfig, "config.yaml"), "CompileFlags: [ { unclosed");
        expect(JSON.stringify(await open())).toContain("FROM_USER");
        expect(await exists(written)).toBe(false);
      } finally {
        process.env.HOME = HOME;
        if (XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = XDG_CONFIG_HOME;
      }
    },
    TEST_TIMEOUT_MS,
  );

  describe("--query-driver", () => {
    /** An executable named `file` that creates `marker` when it runs. */
    async function fakeCompiler(file: string, marker: string): Promise<void> {
      await writeFile(file, `#!/bin/sh\n: > "${marker}"\n`);
      await chmod(file, 0o755);
    }

    /** {@link ClangdLspManager} with the same globs over a directory a test can write to. */
    class ManagerWithCompilers extends ClangdLspManager {
      constructor(
        private readonly compilers: string,
        stateDir: string,
      ) {
        super(process.platform, stateDir);
      }

      protected override spawnArgs(): readonly string[] {
        return [
          ...super.spawnArgs().filter((arg) => !arg.startsWith("--query-driver")),
          `--query-driver=${queryDriverGlobs([this.compilers])}`,
        ];
      }
    }

    async function runWith(compilers: string, root: string, file: string): Promise<void> {
      manager?.destroy();
      manager = new ManagerWithCompilers(compilers, await makeDir());
      const client = new FakeClient(manager);
      await client.start(root);
      await client.openAndWaitForDiagnostics(file);
      await client.shutdown();
    }

    test(
      "runs a compiler matching by name in the directory",
      async () => {
        const compilers = await makeDir();
        const root = await makeDir();
        const marker = join(root, "ran");
        await fakeCompiler(join(compilers, "arm-none-eabi-gcc"), marker);
        const file = await writeProject(root, join(compilers, "arm-none-eabi-gcc"));
        await runWith(compilers, root, file);
        expect(await exists(marker)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "does not run other programs in that directory or below it",
      async () => {
        const compilers = await makeDir();
        const root = await makeDir();
        const marker = join(root, "ran");
        await mkdir(join(compilers, "sub"));
        for (const program of ["evil-compiler", join("sub", "gcc")]) {
          await fakeCompiler(join(compilers, program), marker);
          const file = await writeProject(root, join(compilers, program));
          await runWith(compilers, root, file);
          expect(await exists(marker)).toBe(false);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "does not run compilers in the project, however the database names them",
      async () => {
        const root = await makeDir();
        const marker = join(root, "ran");
        await fakeCompiler(join(root, "evil-compiler"), marker);
        await fakeCompiler(join(root, "gcc"), marker);
        const climbing = `/usr/bin${"/..".repeat(4)}${join(root, "gcc")}`;
        for (const compiler of ["./evil-compiler", "./gcc", join(root, "gcc"), climbing]) {
          const file = await writeProject(root, compiler);
          await runClangd(root, file);
          expect(await exists(marker)).toBe(false);
        }
      },
      TEST_TIMEOUT_MS,
    );
  });
});
