import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
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
 * clangd takes a project's flags from several places, so they are removed where it combines them,
 * by the spelling clang's driver uses or, for `-Xclang`, its frontend: clangd then drops the
 * `-Xclang` before them and their values too. `-Xclang` itself stays, since real builds rely on it
 * (CMake's precompiled headers do). `-Xpreprocessor`, `-Wp,` and `/clang:` also pass flags on, and
 * a `--config` file adds them.
 */
const REMOVED_COMPILE_FLAGS = [
  "--serialize-diagnostics",
  "-serialize-diagnostic-file",
  "-diagnostic-log-file",
  "-dump-minimization-hints=*",
  "-MJ",
  "-gen-cdb-fragment-path",
  "-fmodules-cache-path=*",
  "--config",
  "-Xpreprocessor",
  "-Wp,*",
  "/clang:*",
  // Not output flags: clangd never finishes a file compiled with these, and ignores SIGTERM then.
  "-traditional-cpp",
  "-fincremental-extensions",
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
 * escapes placeholders but writes names as they are, so a `my$fn` would insert the snippet variable
 * `$fn`.
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
  // Skips the escapes clangd writes itself, in placeholders: a name cannot hold a backslash.
  return snippet.replace(/\\[\s\S]|\$(?![0-9{])/g, (match) => (match.length === 2 ? match : "\\$"));
}

/** The oldest clangd that takes the flags and compile flags above. */
const MIN_CLANGD_MAJOR = 16;
/** Apple's stub, which runs Xcode's clangd or offers to install the developer tools. */
const APPLE_CLANGD_STUB = "/usr/bin/clangd";
const PROBE_TIMEOUT_MS = 10_000;

/** A command's exit code and output; a code of null means it could not run or timed out. */
async function probe(
  command: string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string }> {
  try {
    const proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: buildSpawnEnv(),
      timeout: timeoutMs,
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code: proc.signalCode ? null : code, stdout };
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
    ? "clangd not found: install LLVM's (brew install llvm) and put its clangd on PATH"
    : "clangd not found: install it with your package manager, e.g. sudo apt install clangd";
}

const FAILURE_REASONS = {
  apple:
    "Xcode's clangd isn't supported: install LLVM's (brew install llvm) and put its clangd first on PATH",
  "too-old": `clangd ${MIN_CLANGD_MAJOR} or newer is required`,
  unknown: "Could not read the version of the clangd on PATH",
} as const;

export type ClangdCheck = "ok" | keyof typeof FAILURE_REASONS;

/**
 * Whether a clangd found on `PATH` can serve. Xcode's isn't supported, under any path; Apple's stub
 * isn't even run, since that can raise macOS's install dialog. Too old a clangd exits at once on
 * the flags below, and only a version it can read is known to be neither.
 */
export async function checkClangd(
  binary: string,
  platform: NodeJS.Platform,
  run: typeof probe = probe,
): Promise<ClangdCheck> {
  if (platform === "darwin" && realPath(binary) === APPLE_CLANGD_STUB) return "apple";
  const { stdout } = await run([binary, "--version"]);
  if (/\bApple\b/.test(stdout)) return "apple";
  const major = clangdMajorVersion(stdout);
  if (major === null) return "unknown";
  return major < MIN_CLANGD_MAJOR ? "too-old" : "ok";
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

const INDEX_DIRECTORY_PARTS = [".cache", ".cache/clangd", ".cache/clangd/index"];
const TRACKED_SYMLINK_MODE = "120000";
/** clangd's start waits on this, and a filtered `git ls-files` normally takes milliseconds. */
const INDEX_CHECK_TIMEOUT_MS = 3000;

/**
 * Whether clangd's index directory, `.cache/clangd/index` beside a compile database, or a parent of
 * it up to `.cache`, is a symlink: at the worktree's root or tracked by git at any depth. clangd
 * follows such a link, so the index would be written outside the project tree. A git check that
 * does not finish counts as yes: the worktree only loses the index.
 */
export async function indexDirectoryIsSymlink(
  wtPath: string,
  run: typeof probe = probe,
): Promise<boolean> {
  for (const part of INDEX_DIRECTORY_PARTS) {
    try {
      if ((await lstat(join(wtPath, part))).isSymbolicLink()) return true;
    } catch {
      // Not there, which is the usual case.
    }
  }
  const pathspecs = INDEX_DIRECTORY_PARTS.map((part) => `:(glob)**/${part}`);
  const { code, stdout } = await run(
    // The repository's own config must not pick a program to run.
    ["git", "-c", "core.fsmonitor=false", "-C", wtPath, "ls-files", "-s", "-z", "--", ...pathspecs],
    INDEX_CHECK_TIMEOUT_MS,
  );
  // Git exits with an error outside a repository; a null code is a timeout.
  if (code === null) return true;
  return code === 0 && stdout.split("\0").some((line) => line.startsWith(TRACKED_SYMLINK_MODE));
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
  /** Worktrees clangd runs in without its background index. */
  private readonly withoutIndex = new Set<string>();

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
    if (check === "ok") {
      if (await indexDirectoryIsSymlink(context.wtPath)) {
        this.log.info("Background index off: its directory is a symlink", {
          wtPath: context.wtPath,
        });
        this.withoutIndex.add(context.wtPath);
      } else {
        this.withoutIndex.delete(context.wtPath);
      }
      return binary;
    }
    this.log.warn(`Not starting ${binary}`, { check });
    this.failureReasons.set(context.wtPath, FAILURE_REASONS[check]);
    return null;
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    return this.failureReasons.get(context.wtPath) ?? null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    return [
      // Otherwise on by default. Skipped so index files aren't written outside the project tree.
      ...(this.withoutIndex.has(context.wtPath) ? ["--background-index=false"] : []),
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
