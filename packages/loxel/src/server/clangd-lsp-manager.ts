import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord } from "@/lib/is-record";

import { config } from "./config";
import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";
import {
  WorktreeLspManager,
  type SpawnOptions,
  type SuppressibleFeature,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const log = logger.child("clangd-lsp");

/** System directories whose compilers `--query-driver` may run for their include paths. */
const QUERY_DRIVER_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const QUERY_DRIVER_COMPILERS = ["*gcc*", "*g++*", "*clang*"];

/**
 * The `--query-driver` value: only compilers by name in the given directories. clangd runs the
 * compiler a compile database names when it matches, so a directory's every program (`dir/*`) and
 * `**` do not belong here, nor does anything inside a worktree.
 */
export function queryDriverGlobs(dirs: readonly string[] = QUERY_DRIVER_DIRS): string {
  return dirs.flatMap((dir) => QUERY_DRIVER_COMPILERS.map((name) => `${dir}/${name}`)).join(",");
}

/**
 * Compile flags that make the compiler write output files have no place in an editor session.
 * clangd takes a project's flags from several places, so they are removed where it combines them:
 * the `-X` and `-W` forwarders and `/clang:` pass such flags on, and a `--config` file adds them.
 */
const REMOVED_COMPILE_FLAGS = [
  "--serialize-diagnostics",
  "-serialize-diagnostics",
  "-MJ",
  "-gen-cdb-fragment-path",
  "--config",
  "--config=*",
  "-Xclang",
  "-Xpreprocessor",
  "-Wp,*",
  "/clang:*",
  // Not an output flag: clangd never finishes a file compiled with it, and it ignores SIGTERM then.
  "-traditional-cpp",
];

/**
 * clangd's config for compile flags, first in the file so that nothing after it can undo it: clangd
 * still applies this document when a later one does not parse. `--no-default-config` covers the
 * config file a compiler would otherwise load from beside itself.
 */
const COMPILE_FLAGS_CONFIG = `CompileFlags:
  Remove: ${JSON.stringify(REMOVED_COMPILE_FLAGS)}
  Add: ["--no-default-config"]
`;

/** Where clangd reads its user config from, given these variables. */
function clangdUserConfig(
  platform: NodeJS.Platform,
  home: string,
  xdgConfigHome: string | undefined,
): string {
  const base =
    platform === "darwin"
      ? join(home, "Library", "Preferences")
      : xdgConfigHome || join(home, ".config");
  return join(base, "clangd", "config.yaml");
}

/**
 * Write the user config clangd runs with and return the environment that points it there. clangd
 * applies its user config after every project's, so this is what decides the final compile flags.
 * The user's own config follows in the same file and is read again at each start. Only the clangd
 * process sees this environment. Throws when the file cannot be written, which fails the start.
 */
export function prepareClangdUserConfig(
  stateDir: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const own = join(stateDir, "clangd-config");
  const home = env.HOME || homedir();

  let userConfig = "";
  const userConfigPath = clangdUserConfig(platform, home, env.XDG_CONFIG_HOME);
  try {
    userConfig = readFileSync(userConfigPath, "utf8");
  } catch (err) {
    if (!isMissingFile(err)) {
      log.warn("Could not read the clangd user config; starting without it", {
        path: userConfigPath,
        error: err,
      });
    }
  }

  const target = clangdUserConfig(platform, own, own);
  mkdirSync(dirname(target), { recursive: true });
  // Written whole and renamed into place: a running clangd may reread the file at any moment.
  const temporary = `${target}.${process.pid}.tmp`;
  // `...` ends the document; unlike `---`, it adds no empty one when the user's config is empty.
  writeFileSync(temporary, `${COMPILE_FLAGS_CONFIG}...\n${userConfig}`);
  renameSync(temporary, target);

  return platform === "darwin" ? { HOME: own } : { XDG_CONFIG_HOME: own };
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Escape the `$` signs in a completion result's snippets that are not clangd's own tabstops. clangd
 * writes names into snippets as they are, so a `my$fn` would insert the snippet variable `$fn`.
 */
export function escapeSnippetDollars(body: string): string {
  // Most frames have no such `$`, and parsing them again would be wasted.
  if (!/\$[^0-9{]/.test(body)) return body;
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(message) || !isRecord(message.result) || !Array.isArray(message.result.items)) {
    return body;
  }
  for (const item of message.result.items as unknown[]) {
    if (!isRecord(item) || item.insertTextFormat !== SNIPPET_TEXT_FORMAT) continue;
    if (typeof item.insertText === "string") item.insertText = escapeDollars(item.insertText);
    if (isRecord(item.textEdit) && typeof item.textEdit.newText === "string") {
      item.textEdit.newText = escapeDollars(item.textEdit.newText);
    }
  }
  return JSON.stringify(message);
}

const SNIPPET_TEXT_FORMAT = 2;

function escapeDollars(snippet: string): string {
  return snippet.replace(/\$(?![0-9{])/g, "\\$");
}

/** The oldest clangd that takes the flags and compile flags above. */
const MIN_CLANGD_MAJOR = 16;
/** Apple's stub, which runs the clangd of the active developer tools or offers to install them. */
const APPLE_CLANGD_STUB = "/usr/bin/clangd";
const PROBE_TIMEOUT_MS = 10_000;

/** A command's exit code and output; a code of null means it could not run or timed out. */
async function probe(command: string[]): Promise<{ code: number | null; stdout: string }> {
  try {
    const proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: buildSpawnEnv(),
      timeout: PROBE_TIMEOUT_MS,
    });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch (err) {
    log.warn("Could not run a clangd probe", { command: command[0], error: err });
    return { code: null, stdout: "" };
  }
}

/** The major version in `clangd --version` output (LLVM's or Apple's), or null if there is none. */
export function clangdMajorVersion(versionOutput: string): number | null {
  const match = /clangd version (\d+)\./.exec(versionOutput);
  return match ? Number(match[1]) : null;
}

/** What to run for a missing clangd, short enough for a WebSocket close frame. */
function installHint(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "clangd not found: run xcode-select --install in a terminal"
    : "clangd not found: install it with your package manager, e.g. sudo apt install clangd";
}

export type ClangdCheck = "ok" | "not-installed" | "too-old";

/**
 * Whether a clangd found on `PATH` can serve. Running Apple's stub without the developer tools
 * would raise macOS's install dialog at every retry, and `xcode-select -p` tells without doing so.
 * A clangd too old for the flags exits at once. A version that can't be read is left to start.
 */
export async function checkClangd(
  binary: string,
  platform: NodeJS.Platform,
  run: typeof probe = probe,
): Promise<ClangdCheck> {
  if (platform === "darwin" && binary === APPLE_CLANGD_STUB) {
    const { code } = await run(["/usr/bin/xcode-select", "-p"]);
    if (code !== 0) return "not-installed";
  }
  const major = clangdMajorVersion((await run([binary, "--version"])).stdout);
  return major !== null && major < MIN_CLANGD_MAJOR ? "too-old" : "ok";
}

/**
 * Manages clangd child processes, one per worktree, for C, C++ and Objective-C. clangd finds each
 * file's compile command itself, per file, so monorepos with several compile databases work without
 * `--compile-commands-dir`. The binary comes from the login-shell PATH.
 */
export class ClangdLspManager extends WorktreeLspManager {
  // Format on save owns formatting.
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];

  /** Why clangd won't start for a worktree, per worktree since each starts on its own. */
  private readonly failureReasons = new Map<string, string>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly stateDir: string = config.stateDir,
  ) {
    super("clangd-lsp");
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    this.failureReasons.delete(context.wtPath);
    if (this.platform === "win32") {
      this.failureReasons.set(context.wtPath, "clangd is not available on Windows yet");
      return null;
    }
    const binary = this.resolveBundledBinary("clangd");
    if (!binary) {
      this.failureReasons.set(context.wtPath, installHint(this.platform));
      return null;
    }
    const check = await checkClangd(binary, this.platform);
    if (check === "ok") return binary;
    this.log.warn(`Not starting ${binary}`, { check });
    this.failureReasons.set(
      context.wtPath,
      check === "too-old"
        ? `clangd ${MIN_CLANGD_MAJOR} or newer is required`
        : installHint(this.platform),
    );
    return null;
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    return this.failureReasons.get(context.wtPath) ?? null;
  }

  protected override spawnArgs(): readonly string[] {
    return [
      // The defaults cap results: references at 1000 and renames at 50 files.
      "--limit-references=0",
      "--rename-file-limit=0",
      "--header-insertion-decorators=0",
      `--query-driver=${queryDriverGlobs()}`,
    ];
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    super.handleServerFrame(session, escapeSnippetDollars(body));
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return {
      ...super.spawnOptions(context),
      env: prepareClangdUserConfig(this.stateDir, this.platform, buildSpawnEnv()),
    };
  }
}
