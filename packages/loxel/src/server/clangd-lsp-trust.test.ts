import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import "@/test/temp-state-dir";

import { FakeClient } from "./clangd-test-client";

// Before the imports that read it: trust is stored in the state directory.
const stateDir = await mkdtemp(join(tmpdir(), "clangd-trust-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { checkClangd, ClangdLspManager } = await import("./clangd-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

const TEST_TIMEOUT_MS = 60_000;
const BUNDLED_RESTRICTION = "Uses Loxel's own clangd instead of yours.";
const USER_RESTRICTION = "Asks only compilers in system folders for include paths.";

const ORIGINAL_PATH = process.env.PATH;
const dirs: string[] = [];
let manager: InstanceType<typeof ClangdLspManager> | undefined;

afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH;
  await manager?.destroy();
  manager = undefined;
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 })),
  );
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function makeDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "clangd trust-")));
  dirs.push(dir);
  return dir;
}

/** {@link ClangdLspManager} on a machine where `bundled`, if any, ships beside the server. */
class ManagerWithBundled extends ClangdLspManager {
  constructor(
    private readonly bundled: string | null,
    platform: NodeJS.Platform,
    developerTools: boolean,
    state: string,
  ) {
    super(platform, state, async () => developerTools);
  }

  protected override resolveBundledBinary(name: string): string | null {
    return this.bundled ?? super.resolveBundledBinary(name);
  }
}

/** A stand-in clangd answering `initialize`, with this `--version` output and how it started. */
async function standIn(dir: string, versionOutput: string): Promise<string> {
  const answer = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}';
  const file = join(dir, "clangd");
  await writeFile(
    file,
    `#!/bin/sh
if [ "$1" = --version ]; then pwd > "${dir}/version-cwd"; ${versionOutput ? `echo "${versionOutput}"` : "exit 1"}; exit 0; fi
{ echo "$0"; echo "$HOME"; echo "\${XDG_CONFIG_HOME:-}"; echo "$PATH"; printf '%s\\n' "$@"; } > "${dir}/launch"
printf 'Content-Length: ${answer.length}\\r\\n\\r\\n%s' '${answer}'
exec /bin/cat > /dev/null
`,
  );
  await chmod(file, 0o755);
  return file;
}

interface Scene {
  /** `--version` output of the clangd on `PATH`; null for none, empty for one that fails. */
  user: string | null;
  bundled?: boolean;
  trusted: boolean;
  platform?: NodeJS.Platform;
  developerTools?: boolean;
}

/** Start a session on a machine set up this way, and return how its clangd was started. */
async function launch({
  user,
  bundled = true,
  trusted,
  platform = "darwin",
  developerTools = true,
}: Scene) {
  const userDir = await makeDir();
  const userClangd = user === null ? null : await standIn(userDir, user);
  const bundledDir = await makeDir();
  const bundledClangd = bundled ? await standIn(bundledDir, "clangd version 23.1.0") : null;
  if (bundled) await mkdir(join(bundledDir, "clangd-resource"));

  const wt = await makeDir();
  setRepoTrusted(wt, trusted);
  const { PATH } = process.env;
  process.env.PATH = `${userDir}:/bin`;
  try {
    manager = new ManagerWithBundled(bundledClangd, platform, developerTools, await makeDir());
    const client = new FakeClient(manager);
    await client.start(wt);
    const ran = await readFile(join(await whichRan(userDir, bundledDir), "launch"), "utf8");
    const [binary = "", home = "", xdg = "", path = "", ...args] = ran.trim().split("\n");
    return { binary, home, xdg, path, args, userClangd, bundledClangd, userDir, bundledDir, wt };
  } finally {
    process.env.PATH = PATH;
  }
}

/** Which of the two directories' clangd started. */
async function whichRan(userDir: string, bundledDir: string): Promise<string> {
  return (await Bun.file(join(userDir, "launch")).exists()) ? userDir : bundledDir;
}

function queryDriver(args: readonly string[]): string {
  return args.find((arg) => arg.startsWith("--query-driver="))?.split("=")[1] ?? "";
}

describe.skipIf(process.platform === "win32")("clangd in a trusted repository", () => {
  test(
    "runs the user's clangd as the user would",
    async () => {
      const run = await launch({ user: "clangd version 18.1.0", trusted: true });
      expect(run.binary).toBe(run.userClangd ?? "");
      expect(run.home).toBe(process.env.HOME ?? "");
      expect(run.home).not.toContain("clangd-config");
      expect(queryDriver(run.args)).toBe("**");
      expect(run.args.filter((arg) => arg.startsWith("--resource-dir"))).toEqual([]);
      expect(run.args).toContain("--limit-references=0");
      expect(run.args).toContain("--rename-file-limit=0");
      expect(getRepoTrustStatus(run.wt).restrictions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "takes Xcode's, and reads the version from the filesystem root",
    async () => {
      const run = await launch({ user: "Apple clangd version 21.0.0 (clang-2100)", trusted: true });
      expect(run.binary).toBe(run.userClangd ?? "");
      expect((await readFile(join(run.userDir, "version-cwd"), "utf8")).trim()).toBe("/");
    },
    TEST_TIMEOUT_MS,
  );

  test.each([
    ["none", null],
    ["too old", "clangd version 15.0.6"],
    ["unreadable", "not a version"],
    ["failing", ""],
  ] as const)(
    "uses the bundled one when the user's is %s",
    async (_name, user) => {
      const run = await launch({ user, trusted: true });
      expect(run.binary).toBe(run.bundledClangd ?? "");
      expect(run.args).toContain(`--resource-dir=${join(run.bundledDir, "clangd-resource")}`);
      // Still the user's config and compilers: trust decides those, not the binary.
      expect(run.home).not.toContain("clangd-config");
      expect(queryDriver(run.args)).toBe("**");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps clear of Apple's stubs without the developer tools",
    async () => {
      const run = await launch({
        user: "Apple clangd version 21.0.0 (clang-2100)",
        trusted: true,
        developerTools: false,
      });
      expect(run.binary).toBe(run.bundledClangd ?? "");
      const globs = queryDriver(run.args).split(",");
      expect(globs).toContain("/Users/**");
      expect(globs).not.toContain("**");
      expect(globs.some((glob) => glob.startsWith("/usr/bin"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "does not run Apple's stub when the developer tools are missing",
    async () => {
      const ran: string[][] = [];
      const run = async (command: string[]) => {
        ran.push(command);
        return { code: 0, stdout: "" };
      };
      expect(await checkClangd("/usr/bin/clangd", "darwin", run, false)).toBe("apple");
      expect(ran).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "uses the user's config directly on Linux",
    async () => {
      const run = await launch({
        user: "clangd version 18.1.0",
        bundled: false,
        trusted: true,
        platform: "linux",
      });
      expect(run.binary).toBe(run.userClangd ?? "");
      expect(run.xdg).not.toContain("clangd-config");
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(process.platform === "win32")("clangd in an untrusted repository", () => {
  test(
    "prefers the bundled one, and asks because the user has their own",
    async () => {
      const run = await launch({ user: "clangd version 18.1.0", trusted: false });
      expect(run.binary).toBe(run.bundledClangd ?? "");
      expect((await readFile(join(run.userDir, "version-cwd"), "utf8")).trim()).toBe("/");
      expect(run.home).toContain("clangd-config");
      expect(queryDriver(run.args)).toContain("/usr/bin/*clang*");
      expect(queryDriver(run.args).split(",")).not.toContain("**");
      expect(getRepoTrustStatus(run.wt).restrictions).toEqual([BUNDLED_RESTRICTION]);
    },
    TEST_TIMEOUT_MS,
  );

  test.each([
    ["no clangd", null],
    ["too old a clangd", "clangd version 15.0.6"],
  ] as const)(
    "does not ask when the user has %s",
    async (_name, user) => {
      const run = await launch({ user, trusted: false });
      expect(run.binary).toBe(run.bundledClangd ?? "");
      expect(getRepoTrustStatus(run.wt).restrictions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "does not ask without the developer tools when Xcode's is all there is",
    async () => {
      const run = await launch({
        user: "Apple clangd version 21.0.0 (clang-2100)",
        trusted: false,
        developerTools: false,
      });
      expect(getRepoTrustStatus(run.wt).restrictions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "says what is held back where the user's clangd is the only one",
    async () => {
      const run = await launch({
        user: "clangd version 18.1.0",
        bundled: false,
        trusted: false,
        platform: "linux",
      });
      expect(run.binary).toBe(run.userClangd ?? "");
      expect(run.xdg).toContain("clangd-config");
      expect(getRepoTrustStatus(run.wt).restrictions).toEqual([USER_RESTRICTION]);
    },
    TEST_TIMEOUT_MS,
  );
});

/** A clangd that the untrusted path also accepts; the swap needs both modes to run for real. */
const REAL_CLANGD = Bun.which("clangd");
const REAL_CLANGD_IS_LLVM =
  REAL_CLANGD !== null &&
  !Bun.spawnSync([REAL_CLANGD, "--version"]).stdout.toString().includes("Apple");

/**
 * A project that compiles only with what trust brings: a cross-compiler-style script in the project,
 * under a name no system glob matches, giving the include path, and a macro from `-Wp,`.
 */
async function writeCrossProject(root: string): Promise<{ file: string; ran: string }> {
  const sysroot = join(root, "sysroot");
  await mkdir(sysroot);
  await writeFile(join(sysroot, "cross_only.h"), "#define CROSS 1\n");
  const ran = join(root, "ran");
  const compiler = join(root, "xtensa-cc");
  await writeFile(
    compiler,
    `#!/bin/sh
: > "${ran}"
cat >&2 <<EOF
#include <...> search starts here:
 ${sysroot}
End of search list.
EOF
`,
  );
  await chmod(compiler, 0o755);
  const file = join(root, "x.cpp");
  await writeFile(file, "#include <cross_only.h>\nint x = CROSS + FROM_WP;\n");
  const entry = {
    directory: root,
    file,
    arguments: ["./xtensa-cc", "-Wp,-DFROM_WP=1", "-c", "x.cpp"],
  };
  await writeFile(join(root, "compile_commands.json"), JSON.stringify([entry]));
  return { file, ran };
}

describe.skipIf(REAL_CLANGD === null || process.platform === "win32")("real clangd", () => {
  test(
    "asks a compiler the project names for its include paths",
    async () => {
      const root = await makeDir();
      const { file, ran } = await writeCrossProject(root);
      setRepoTrusted(root, true);
      manager = new ClangdLspManager(process.platform, await makeDir());
      const client = new FakeClient(manager);
      await client.start(root);
      expect(await client.openAndWaitForDiagnostics(file)).toEqual([]);
      expect(await Bun.file(ran).exists()).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!REAL_CLANGD_IS_LLVM)(
    "moving between untrusted and trusted restarts it, with the file's features back",
    async () => {
      const root = await makeDir();
      const { file, ran } = await writeCrossProject(root);
      setRepoTrusted(root, false);
      manager = new ClangdLspManager(process.platform, await makeDir());

      const untrusted = new FakeClient(manager);
      await untrusted.start(root);
      expect((await untrusted.openAndWaitForDiagnostics(file)).length).toBeGreaterThan(0);
      expect(await Bun.file(ran).exists()).toBe(false);

      setRepoTrusted(root, true);
      expect((await untrusted.closed).code).toBe(LSP_RESTART_CLOSE_CODE);
      const trusted = new FakeClient(manager);
      await trusted.start(root);
      expect(await trusted.openAndWaitForDiagnostics(file)).toEqual([]);
      expect(await Bun.file(ran).exists()).toBe(true);
      const hover = await trusted.request("textDocument/hover", {
        textDocument: { uri: Bun.pathToFileURL(file).href },
        position: { line: 1, character: 4 },
      });
      expect(JSON.stringify(hover)).toContain("x");

      setRepoTrusted(root, false);
      expect((await trusted.closed).code).toBe(LSP_RESTART_CLOSE_CODE);
      const again = new FakeClient(manager);
      await again.start(root);
      expect((await again.openAndWaitForDiagnostics(file)).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
