import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { $, type ServerWebSocket } from "bun";

import { LSP_START_FAILED_CLOSE_CODE } from "@/api/ws-protocol";

import {
  checkClangd,
  clangdMajorVersion,
  ClangdLspManager,
  escapeSnippetDollars,
  indexDirectoryIsSymlink,
  prepareClangdUserConfig,
  queryDriverGlobs,
} from "./clangd-lsp-manager";

/** A clangd the manager will run: Xcode's isn't supported. */
const CLANGD = Bun.which("clangd");
const CLANGD_IS_SUPPORTED =
  CLANGD !== null && !Bun.spawnSync([CLANGD, "--version"]).stdout.toString().includes("Apple");
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
  /** The socket's close, for a server that never starts. */
  readonly closed: Promise<{ code?: number; reason?: string }>;
  private nextId = 1;
  private readonly responses = new Map<number, (result: unknown) => void>();
  private readonly diagnosticsWaiters = new Map<string, (diagnostics: unknown[]) => void>();

  constructor(private readonly server: ClangdLspManager) {
    const { promise, resolve } = Promise.withResolvers<{ code?: number; reason?: string }>();
    this.closed = promise;
    const ws = {
      send: (data: string) => {
        this.receive(data);
        return data.length;
      },
      close: (code?: number, reason?: string) => resolve({ code, reason }),
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

describe("escapeSnippetDollars", () => {
  const frame = (item: Record<string, unknown>) =>
    JSON.stringify({ id: 1, result: { isIncomplete: false, items: [item] } });

  test("escapes names in snippets and leaves tabstops alone", () => {
    const escaped = JSON.parse(
      escapeSnippetDollars(
        frame({
          insertText: "my$fn(${1:int \\$a}, $0)",
          insertTextFormat: 2,
          textEdit: { newText: "FOO$BAR(${1:x})" },
        }),
      ),
    ) as { result: { items: { insertText: string; textEdit: { newText: string } }[] } };
    expect(escaped.result.items[0]?.insertText).toBe("my\\$fn(${1:int \\$a}, $0)");
    expect(escaped.result.items[0]?.textEdit.newText).toBe("FOO\\$BAR(${1:x})");
  });

  test("escapes a digit after a $ in a name, and keeps a template's tabstop", () => {
    const items = (body: string) =>
      (JSON.parse(body) as { result: { items: { insertText: string }[] } }).result.items;
    const escape = (insertText: string) =>
      items(escapeSnippetDollars(frame({ insertText, insertTextFormat: 2 })))[0]?.insertText;
    expect(escape("f$1(${1:int x})")).toBe("f\\$1(${1:int x})");
    expect(escape("mk$1<$1>()$0")).toBe("mk\\$1<$1>()$0");
  });

  test("leaves plain text items, other frames and frames with no such $ as they are", () => {
    const plain = frame({ insertText: "my$var", insertTextFormat: 1 });
    expect(JSON.parse(escapeSnippetDollars(plain))).toEqual(JSON.parse(plain));
    const hover = JSON.stringify({ id: 2, result: { contents: "costs $x" } });
    expect(escapeSnippetDollars(hover)).toBe(hover);
    const tabstops = frame({ insertText: "f(${1:x})", insertTextFormat: 2 });
    expect(escapeSnippetDollars(tabstops)).toBe(tabstops);
  });
});

describe.skipIf(process.platform === "win32")("indexDirectoryIsSymlink", () => {
  test("finds a link at the root, at every part of the path", async () => {
    for (const part of [".cache", ".cache/clangd", ".cache/clangd/index"]) {
      const root = await makeDir();
      await mkdir(join(root, part, ".."), { recursive: true });
      await symlink(await makeDir(), join(root, part));
      expect(await indexDirectoryIsSymlink(root)).toBe(true);
    }
  });

  test("finds a link git tracks below the root", async () => {
    const root = await makeDir();
    await mkdir(join(root, "sub", ".cache", "clangd"), { recursive: true });
    await symlink("../../../..", join(root, "sub", ".cache", "clangd", "index"));
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} add -A`.quiet();
    expect(await indexDirectoryIsSymlink(root)).toBe(true);
  });

  test("leaves real directories, other links and non-repositories alone", async () => {
    const root = await makeDir();
    await mkdir(join(root, ".cache", "clangd", "index"), { recursive: true });
    await symlink("..", join(root, "other-link"));
    expect(await indexDirectoryIsSymlink(root)).toBe(false);
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} add -A`.quiet();
    expect(await indexDirectoryIsSymlink(root)).toBe(false);
  });

  test("counts a git check that did not finish as a link", async () => {
    const timedOut = async () => ({ code: null, stdout: "" });
    expect(await indexDirectoryIsSymlink(await makeDir(), timedOut)).toBe(true);
  });
});

describe("checkClangd", () => {
  const VERSION_OUTPUT = (version: string) => `clangd version ${version} (https://example)\n`;

  test("reads LLVM's and Apple's version lines", () => {
    expect(clangdMajorVersion(VERSION_OUTPUT("23.1.0"))).toBe(23);
    expect(clangdMajorVersion("Apple clangd version 21.0.0 (clang-2100.1.1.101)\n")).toBe(21);
    expect(clangdMajorVersion("something else")).toBeNull();
  });

  test("takes version 16 and newer, and refuses a version it can't read", async () => {
    const answering = (stdout: string) => async () => ({ code: 0, stdout });
    const check = (stdout: string) => checkClangd("/opt/clangd", "linux", answering(stdout));
    expect(await check(VERSION_OUTPUT("15.0.6"))).toBe("too-old");
    expect(await check(VERSION_OUTPUT("16.0.2"))).toBe("ok");
    expect(await check("Homebrew clangd version 21.1.0\n")).toBe("ok");
    expect(await check("")).toBe("unknown");
  });

  test("refuses Xcode's clangd under any path", async () => {
    const apple = async () => ({ code: 0, stdout: "Apple clangd version 21.0.0 (clang-2100)\n" });
    expect(await checkClangd("/opt/somewhere/clangd", "darwin", apple)).toBe("apple");
    expect(await checkClangd("/opt/somewhere/clangd", "linux", apple)).toBe("apple");
  });

  test("reads the version of a /usr/bin/clangd on Linux", async () => {
    const commands: string[][] = [];
    const run = async (command: string[]) => {
      commands.push(command);
      return { code: 0, stdout: VERSION_OUTPUT("20.1.0") };
    };
    expect(await checkClangd("/usr/bin/clangd", "linux", run)).toBe("ok");
    expect(commands).toEqual([["/usr/bin/clangd", "--version"]]);
  });

  test.skipIf(process.platform !== "darwin")(
    "does not run Apple's stub, also by a link",
    async () => {
      const link = join(await makeDir(), "clangd");
      await symlink("/usr/bin/clangd", link);
      const never = async () => {
        throw new Error("must not run");
      };
      expect(await checkClangd("/usr/bin/clangd", "darwin", never)).toBe("apple");
      expect(await checkClangd(link, "darwin", never)).toBe("apple");
    },
  );
});

describe("ClangdLspManager", () => {
  test("does not start on Windows, and says so", async () => {
    manager = new ClangdLspManager("win32", await makeDir());
    const client = new FakeClient(manager);
    manager.createSession(client.ws, await makeDir());
    expect(await client.closed).toEqual({
      code: LSP_START_FAILED_CLOSE_CODE,
      reason: "clangd is not available on Windows yet",
    });
  });

  test.skipIf(process.platform === "win32")("says what to run for a missing clangd", async () => {
    const { PATH } = process.env;
    process.env.PATH = await makeDir();
    try {
      for (const [platform, command] of [
        ["darwin", "brew install llvm"],
        ["linux", "apt install clangd"],
      ] as const) {
        manager = new ClangdLspManager(platform, await makeDir());
        const client = new FakeClient(manager);
        manager.createSession(client.ws, await makeDir());
        const { code, reason } = await client.closed;
        expect(code).toBe(LSP_START_FAILED_CLOSE_CODE);
        expect(reason).toContain(command);
      }
    } finally {
      process.env.PATH = PATH;
    }
  });

  test.skipIf(process.platform === "win32")(
    "names the version a clangd falls short of",
    async () => {
      const bin = await makeDir();
      await writeFile(join(bin, "clangd"), '#!/bin/sh\necho "clangd version 15.0.6"\n');
      await chmod(join(bin, "clangd"), 0o755);
      const { PATH } = process.env;
      process.env.PATH = `${bin}:${PATH}`;
      try {
        manager = new ClangdLspManager(process.platform, await makeDir());
        const client = new FakeClient(manager);
        manager.createSession(client.ws, await makeDir());
        expect(await client.closed).toEqual({
          code: LSP_START_FAILED_CLOSE_CODE,
          reason: "clangd 16 or newer is required",
        });
      } finally {
        process.env.PATH = PATH;
      }
    },
  );
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

describe.skipIf(!CLANGD_IS_SUPPORTED || process.platform === "win32")(
  "ClangdLspManager with clangd",
  () => {
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
      /** Flags that write on every supported clangd, each given the path `written` as its output. */
      const flagsWriting = (written: string): readonly (readonly string[])[] => [
        ["-Xclang", "-diagnostic-log-file", "-Xclang", written],
        [`-Wp,-diagnostic-log-file,${written}`],
        ["-Xpreprocessor", "-diagnostic-log-file", "-Xpreprocessor", written],
        ["-MJ", written],
        ["-gen-cdb-fragment-path", written],
        ["-fmodules", `-fmodules-cache-path=${written}`],
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
          await writeFile(join(root, "flags.rsp"), `-MJ "${written}"\n`);
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
          await writeFile(join(root, "compile_flags.txt"), `-MJ\n${written}\n`);
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
          await writeFile(join(root, ".clangd"), `CompileFlags:\n  Add: ["-MJ", "${written}"]\n`);
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
          await writeFile(join(root, "clang++.cfg"), `-MJ "${written}"\n`);
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
        "that clangd cannot finish a file with",
        async () => {
          const root = await makeDir();
          for (const flags of [["-traditional-cpp"], ["-Xclang", "-fincremental-extensions"]]) {
            const file = await writeProject(root, "/usr/bin/c++", flags);
            await runClangd(root, file);
          }
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "and passes the rest of -Xclang through, with nothing left behind",
        async () => {
          const root = await makeDir();
          await writeFile(join(root, "defines.h"), "#define FROM_INCLUDE 1\n");
          const file = await writeProject(root, "/usr/bin/c++", [
            "-Xclang",
            "-include",
            "-Xclang",
            join(root, "defines.h"),
            "-Xclang",
            "-diagnostic-log-file",
            "-Xclang",
            join(root, "written"),
          ]);
          await writeFile(file, "int x = FROM_INCLUDE;\n");
          manager?.destroy();
          manager = new ClangdLspManager(process.platform, await makeDir());
          const client = new FakeClient(manager);
          await client.start(root);
          expect(await client.openAndWaitForDiagnostics(file)).toEqual([]);
          await client.shutdown();
          expect(await exists(join(root, "written"))).toBe(false);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "and keeps the flags a project needs",
        async () => {
          const root = await makeDir();
          const file = join(root, "x.cpp");
          await writeFile(file, "int x = MISSING;\n");
          await writeFile(join(root, "compile_flags.txt"), "-DMISSING=1\n-MJ\nwritten\n");
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
          const file = await writeProject(root, "/usr/bin/c++", ["-MJ", written]);
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

    test(
      "skips the background index when its directory is a symlink",
      async () => {
        const root = await makeDir();
        const elsewhere = await makeDir();
        await mkdir(join(root, ".cache", "clangd"), { recursive: true });
        await symlink(elsewhere, join(root, ".cache", "clangd", "index"));
        const file = await writeProject(root, "/usr/bin/c++");
        await runClangd(root, file);
        expect(await readdir(elsewhere)).toEqual([]);
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
            ...super.spawnArgs({ wtPath: "" }).filter((arg) => !arg.startsWith("--query-driver")),
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
          for (const program of ["project-compiler", join("sub", "gcc")]) {
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
          await fakeCompiler(join(root, "project-compiler"), marker);
          await fakeCompiler(join(root, "gcc"), marker);
          const climbing = `/usr/bin${"/..".repeat(4)}${join(root, "gcc")}`;
          for (const compiler of ["./project-compiler", "./gcc", join(root, "gcc"), climbing]) {
            const file = await writeProject(root, compiler);
            await runClangd(root, file);
            expect(await exists(marker)).toBe(false);
          }
        },
        TEST_TIMEOUT_MS,
      );
    });
  },
);
