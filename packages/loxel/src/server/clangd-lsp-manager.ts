import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket, Subprocess } from "bun";

import type { CompileDatabaseStatus } from "@/api/c-cpp-compile-database-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import {
  ClangdFileChanges,
  classifyChange,
  INDEX_REFRESH_MIN_INTERVAL_MS,
  INDEX_REFRESH_QUIET_MS,
} from "./clangd-file-changes";
import {
  compileCommandsDir,
  refreshCompileDatabases,
  resolveCompileDatabases,
  subscribeCompileDatabases,
} from "./compile-database";
import { config } from "./config";
import { FSMONITOR_OFF } from "./git-commands";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import { reportRepoRestriction } from "./repo-trust";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import { isInside } from "./shipped-by-repo";
import {
  WorktreeLspManager,
  type SpawnOptions,
  type SuppressibleFeature,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const log = logger.child("clangd-lsp");

/** Holds Apple's stubs, such as `xcrun` and `clang`, that offer to install the developer tools. */
const APPLE_STUB_DIR = "/usr/bin";
/** System directories whose compilers `--query-driver` may run for their include paths. */
const QUERY_DRIVER_DIRS = [APPLE_STUB_DIR, "/usr/local/bin", "/opt/homebrew/bin"];
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
 * `--query-driver` in a trusted repository: whatever compiler its compile database names, since
 * cross-compilers and wrappers go by many names and live anywhere, the project included.
 */
const TRUSTED_QUERY_DRIVER = "**";
/** Where compilers live on a Mac without developer tools, whose `/usr/bin` stubs offer an install. */
const TRUSTED_QUERY_DRIVER_WITHOUT_STUBS = [
  "/Applications",
  "/Library",
  "/nix",
  "/Users",
  "/Volumes",
  "/opt",
  "/private",
  "/tmp",
  "/usr/local",
]
  .map((root) => `${root}/**`)
  .join(",");

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
  if (!/\$(?![{0])/.test(body)) return body;
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
  // Skips the escapes clangd writes itself, in placeholders (a name cannot hold a backslash), and
  // its tabstops: `${`, `$0` and the `<$1>` of a template. A name holding `$0` stays ambiguous.
  return snippet.replace(/\\[\s\S]|\$\{|\$0|<\$1>|\$/g, (match) => (match === "$" ? "\\$" : match));
}

/** The oldest clangd that takes the flags and compile flags above. */
const MIN_CLANGD_MAJOR = 16;
/** Apple's stub, which runs Xcode's clangd or offers to install the developer tools. */
const APPLE_CLANGD_STUB = `${APPLE_STUB_DIR}/clangd`;
/** Beside the bundled binary, holding the compiler headers its release keeps in `lib/clang/<major>`. */
const BUNDLED_RESOURCE_DIR = "clangd-resource";
/** What an untrusted repository leaves out, where a bundled clangd runs and the user has their own. */
const BUNDLED_CLANGD_RESTRICTION = "Uses Loxel's own clangd instead of yours.";
/** The same where the user's own clangd runs anyway, as nothing is bundled for the platform. */
const USER_CLANGD_RESTRICTION = "Asks only compilers in system folders for include paths.";
/** `window/showMessage`'s warning type. */
const MESSAGE_TYPE_WARNING = 2;
const NO_DEVELOPER_TOOLS_MESSAGE =
  "Standard headers need Apple's developer tools: run xcode-select --install in a terminal, then Restart Language Servers";
const PROBE_TIMEOUT_MS = 10_000;

/**
 * A command's exit code and output; a code of null means it could not run or timed out. It runs from
 * the filesystem root, where a version manager's shim finds no project files to act on.
 */
async function probe(
  command: string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
  env: Record<string, string | undefined> = buildSpawnEnv(),
): Promise<{ code: number | null; stdout: string }> {
  try {
    const proc = Bun.spawn(command, {
      cwd: "/",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env,
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

/** Whether the developer tools are installed. Unlike Apple's stubs, this raises no dialog. */
export async function hasDeveloperTools(run: typeof probe = probe): Promise<boolean> {
  return (await run(["/usr/bin/xcode-select", "-p"])).code === 0;
}

const FAILURE_REASONS = {
  apple:
    "Xcode's clangd isn't supported: install LLVM's (brew install llvm) and put its clangd first on PATH",
  "too-old": `clangd ${MIN_CLANGD_MAJOR} or newer is required`,
  unknown: "Could not read the version of the clangd on PATH",
} as const;

export type ClangdCheck = "ok" | keyof typeof FAILURE_REASONS;

/**
 * Whether a clangd found on `PATH` can serve. Unless `appleAllowed`, Xcode's isn't taken, under any
 * path, and Apple's stub isn't even run, since that can raise macOS's install dialog. Too old a
 * clangd exits at once on the flags below, and only a version it can read is known to be neither.
 */
export async function checkClangd(
  binary: string,
  platform: NodeJS.Platform,
  run: typeof probe = probe,
  appleAllowed = false,
): Promise<ClangdCheck> {
  if (!appleAllowed && platform === "darwin" && realPath(binary) === APPLE_CLANGD_STUB) {
    return "apple";
  }
  const { stdout } = await run([binary, "--version"]);
  if (!appleAllowed && /\bApple\b/.test(stdout)) return "apple";
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
 * it up to `.cache`, is a symlink: at the worktree's root, under a folder passed to clangd as
 * `databaseDir`, or tracked by git at any depth. So too the folders down to `databaseDir` inside the
 * worktree. clangd follows such a link, so the index would be written outside the project tree. A
 * git check that does not finish, or finds no git, counts as yes: the worktree only loses the index.
 */
export async function indexDirectoryIsSymlink(
  wtPath: string,
  run: typeof probe = probe,
  databaseDir: string | null = null,
): Promise<boolean> {
  const paths = INDEX_DIRECTORY_PARTS.map((part) => join(wtPath, part));
  if (databaseDir) {
    paths.push(...INDEX_DIRECTORY_PARTS.map((part) => join(databaseDir, part)));
    for (let dir = databaseDir; dir !== wtPath && isInside(dir, wtPath); dir = dirname(dir)) {
      paths.push(dir);
    }
  }
  for (const candidate of paths) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) return true;
    } catch {
      // Not there, which is the usual case.
    }
  }
  const pathspecs = INDEX_DIRECTORY_PARTS.map((part) => `:(glob)**/${part}`);
  const { code, stdout } = await run(
    // The repository's own config must not pick a program to run.
    ["git", ...FSMONITOR_OFF, "-C", wtPath, "ls-files", "-s", "-z", "--", ...pathspecs],
    INDEX_CHECK_TIMEOUT_MS,
  );
  // Git exits with an error outside a repository; a null code is a timeout or no git to run.
  if (code === null) return true;
  return code === 0 && stdout.split("\0").some((line) => line.startsWith(TRACKED_SYMLINK_MODE));
}

function withoutAppleStubs(pathVariable: string | undefined): string {
  return (pathVariable ?? "")
    .split(delimiter)
    .filter((dir) => normalize(`${dir}/`) !== `${APPLE_STUB_DIR}/`)
    .join(delimiter);
}

/** `probe`, for a Mac where a program found in Apple's stub directory would offer an install. */
const probeWithoutAppleStubs: typeof probe = (command, timeoutMs) => {
  const env = buildSpawnEnv();
  return probe(command, timeoutMs, { ...env, PATH: withoutAppleStubs(env.PATH) });
};

/**
 * Whether clangd finds a `compile_commands.json` for any of these documents, the way it looks: in
 * each folder from the file's upward and its `build/` subfolder. Without one it has no index.
 */
export function hasCompileDatabase(documentUris: Iterable<string>): boolean {
  for (const uri of documentUris) {
    let dir = dirname(fileURLToPath(uri));
    while (true) {
      if (
        existsSync(join(dir, "compile_commands.json")) ||
        existsSync(join(dir, "build", "compile_commands.json"))
      ) {
        return true;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

/** Pre-check for a document's opening, change or closing, so other frames are not parsed. */
const DOCUMENT_SYNC_METHOD = /"method"\s*:\s*"textDocument\/did(?:Open|Change|Close)"/;

/** What a worktree's clangd starts with, worked out when its binary resolves. */
interface ClangdLaunch {
  withoutIndex: boolean;
  /** The bundled binary's headers. A clangd from `PATH` has its own, which must match it. */
  resourceDir: string | null;
  /** False on a Mac where running Apple's stubs would offer to install the developer tools. */
  developerTools: boolean;
  /** Passed as `--compile-commands-dir`; null leaves finding each file's database to clangd. */
  compileCommandsDir: string | null;
}

/** A live session's view of the files changing under it. */
interface ClangdSessionFiles {
  changes: ClangdFileChanges;
  /** Each open document's URI and the version the client last gave it. */
  openDocuments: Map<string, number>;
  stopFollowingDatabases: () => void;
}

/**
 * Manages clangd child processes, one per worktree, for C, C++ and Objective-C. clangd finds each
 * file's compile command itself, per file, so monorepos with several compile databases work without
 * `--compile-commands-dir`, which goes only where that search finds nothing (compile-database.ts).
 * In a trusted repository the binary is the login-shell PATH's, else the
 * bundled one; otherwise the bundled one, else the PATH's.
 */
export class ClangdLspManager extends WorktreeLspManager {
  protected override readonly repoTrustRestriction = BUNDLED_CLANGD_RESTRICTION;
  // Reported from `resolveBinary`, which knows whether the user has a clangd to be held back from.
  protected override readonly reportsRestrictionAtStart = false;
  // Format on save owns formatting.
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];

  /** Why clangd won't start for a worktree, per worktree since each starts on its own. */
  private readonly failureReasons = new Map<string, string>();
  private readonly launches = new Map<string, ClangdLaunch>();
  private readonly sessionFiles = new Map<WtLspSession, ClangdSessionFiles>();
  /** Per worktree, since a refresh is a restart and so ends the session that would remember. */
  private readonly indexRefreshedAt = new Map<string, number>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly stateDir: string = config.stateDir,
    private readonly findDeveloperTools: () => Promise<boolean> = hasDeveloperTools,
  ) {
    super("clangd-lsp");
  }

  /**
   * Keep open documents current with the disk, whichever file changed and whoever changed it. One
   * `didSave` of any open document makes clangd check them all, so unlike the base's hook this does
   * not depend on the changed file being open.
   */
  override notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const root = resolve(wtPath);
    for (const [session, files] of this.sessionFiles) {
      if (resolve(session.wtPath) !== root) continue;
      files.changes.pathsChanged(paths.map((changed) => relative(root, changed)));
    }
  }

  override notifyIgnoredPathChanged(wtPath: string, relPath: string): void {
    if (classifyChange(relPath) === null) return;
    const root = resolve(wtPath);
    for (const [session, files] of this.sessionFiles) {
      if (resolve(session.wtPath) === root) files.changes.ignoredPathChanged(relPath);
    }
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    this.failureReasons.delete(context.wtPath);
    if (this.platform === "win32") {
      this.failureReasons.set(context.wtPath, "clangd is not available on Windows yet");
      return null;
    }
    const developerTools = this.platform !== "darwin" || (await this.findDeveloperTools());
    const userClangd = await this.findUserClangd(developerTools, context.repoTrusted);
    const usesUserClangd = context.repoTrusted && userClangd !== null;
    const binary = usesUserClangd ? userClangd : this.resolveBundledBinary("clangd");
    if (!binary) {
      this.failureReasons.set(context.wtPath, installHint(this.platform));
      return null;
    }
    const check = usesUserClangd ? "ok" : await checkClangd(binary, this.platform);
    if (check === "ok") {
      // The sentence is about the user's own clangd: without one, the UI doesn't ask.
      if (!context.repoTrusted && userClangd !== null) {
        reportRepoRestriction(
          context.wtPath,
          binary === userClangd ? USER_CLANGD_RESTRICTION : BUNDLED_CLANGD_RESTRICTION,
        );
      }
      const databases = await resolveCompileDatabases(context.wtPath);
      const databaseDir = compileCommandsDir(databases);
      // The index goes beside the database, and stays in the project tree. The flag beats `.clangd`.
      const indexLeavesWorktree =
        !context.repoTrusted && databaseDir === null && databases.namesOutsideDatabase;
      const withoutIndex =
        indexLeavesWorktree ||
        (await indexDirectoryIsSymlink(
          context.wtPath,
          developerTools ? probe : probeWithoutAppleStubs,
          databaseDir,
        ));
      if (withoutIndex) {
        this.log.info("Background index off: its directory is or may be a symlink", {
          wtPath: context.wtPath,
        });
      }
      const resourceDir = join(dirname(binary), BUNDLED_RESOURCE_DIR);
      this.launches.set(context.wtPath, {
        withoutIndex,
        resourceDir: !usesUserClangd && existsSync(resourceDir) ? resourceDir : null,
        developerTools,
        compileCommandsDir: databaseDir,
      });
      return binary;
    }
    this.log.warn(`Not starting ${binary}`, { check });
    this.failureReasons.set(context.wtPath, FAILURE_REASONS[check]);
    return null;
  }

  /**
   * The login-shell `PATH`'s clangd, Xcode's included, if it can serve. Null otherwise, whatever the
   * reason, so that a bundled one takes over. Without the developer tools, Apple's stub isn't run.
   */
  private async findUserClangd(
    developerTools: boolean,
    repoTrusted: boolean,
  ): Promise<string | null> {
    const found = Bun.which("clangd", { PATH: buildSpawnEnv().PATH ?? "" });
    if (!found) {
      // It may have been installed since the login-shell PATH was captured; the next start retries.
      // Only where it would be used: `resolveBundledBinary` does this when it comes to the PATH.
      if (repoTrusted) void refreshLoginShellEnv();
      return null;
    }
    const check = await checkClangd(
      found,
      this.platform,
      developerTools ? probe : probeWithoutAppleStubs,
      developerTools,
    );
    if (check === "ok") return found;
    this.log.info(`Not using ${found}`, { check });
    return null;
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    return this.failureReasons.get(context.wtPath) ?? null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const launch = this.launches.get(context.wtPath);
    return [
      // Otherwise on by default. Skipped so index files aren't written outside the project tree.
      ...(launch?.withoutIndex ? ["--background-index=false"] : []),
      ...(launch?.resourceDir ? [`--resource-dir=${launch.resourceDir}`] : []),
      ...(launch?.compileCommandsDir
        ? [`--compile-commands-dir=${launch.compileCommandsDir}`]
        : []),
      // The defaults cap results: references at 1000 and renames at 50 files.
      "--limit-references=0",
      "--rename-file-limit=0",
      "--header-insertion-decorators=0",
      `--query-driver=${this.queryDriver(context.repoTrusted, launch?.developerTools !== false)}`,
    ];
  }

  private queryDriver(repoTrusted: boolean, developerTools: boolean): string {
    if (repoTrusted) {
      return developerTools ? TRUSTED_QUERY_DRIVER : TRUSTED_QUERY_DRIVER_WITHOUT_STUBS;
    }
    return queryDriverGlobs(
      developerTools
        ? QUERY_DRIVER_DIRS
        : QUERY_DRIVER_DIRS.filter((dir) => dir !== APPLE_STUB_DIR),
    );
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    const session = super.buildSession(ws, proc, context);
    const openDocuments = new Map<string, number>();
    const stopFollowingDatabases = subscribeCompileDatabases(session.wtPath, ({ status }) => {
      this.restartIfDatabaseDirChanged(session, status);
    });
    // Anything that changed between this start's own look and the subscription.
    refreshCompileDatabases(session.wtPath);
    this.sessionFiles.set(session, {
      openDocuments,
      stopFollowingDatabases,
      changes: new ClangdFileChanges({
        recheck: () => this.recheckOpenDocuments(session),
        rebuild: () => this.rebuildOpenDocuments(session),
        indexDirectoryChanged: () => void this.restartIfIndexDirectoryIsSymlink(session),
        isOpen: (relPath) => openDocuments.has(fileUri(join(session.wtPath, relPath))),
        refreshIndex: () => this.refreshIndex(session),
        databasesChanged: () => {
          refreshCompileDatabases(session.wtPath, true);
          void this.restartIfIndexDirectoryIsSymlink(session);
        },
      }),
    });
    return session;
  }

  protected override onSessionClosed(session: WtLspSession): void {
    const files = this.sessionFiles.get(session);
    files?.changes.dispose();
    files?.stopFollowingDatabases();
    this.sessionFiles.delete(session);
  }

  protected override handleClientData(session: WtLspSession, data: string): void {
    if (DOCUMENT_SYNC_METHOD.test(data)) this.trackDocument(session, data);
    super.handleClientData(session, data);
  }

  private trackDocument(session: WtLspSession, data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message) || !isRecord(message.params)) return;
    const { textDocument } = message.params;
    if (!isRecord(textDocument) || typeof textDocument.uri !== "string") return;
    const { uri, version } = textDocument;
    // A `loxel:` model reaches clangd too, but is no file: nothing here can name it to clangd.
    if (!uri.startsWith("file:///")) return;
    const openDocuments = this.sessionFiles.get(session)?.openDocuments;
    if (message.method === "textDocument/didClose") {
      openDocuments?.delete(uri);
    } else if (typeof version === "number") {
      openDocuments?.set(uri, version);
    }
  }

  private recheckOpenDocuments(session: WtLspSession): void {
    const [uri] = this.sessionFiles.get(session)?.openDocuments.keys() ?? [];
    if (uri) {
      this.notifyServer(session, "textDocument/didSave", { textDocument: { uri } });
    }
  }

  /**
   * With the client's version: clangd would otherwise number the rebuild itself, and stamp its quick
   * fixes with a version the client does not have, which refuses them.
   */
  private rebuildOpenDocuments(session: WtLspSession): void {
    for (const [uri, version] of this.sessionFiles.get(session)?.openDocuments ?? []) {
      this.notifyServer(session, "textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [],
        forceRebuild: true,
      });
    }
  }

  private notifyServer(session: WtLspSession, method: string, params: unknown): void {
    if (!this.isSessionLive(session)) return;
    try {
      this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", method, params }));
    } catch (err) {
      // A server that has closed its stdin, not yet reaped: this runs in a timer.
      this.log.debug(`Could not send ${method}`, { error: err });
    }
  }

  /** Respawn under the check that clangd's start makes, which turns the index off. */
  private async restartIfIndexDirectoryIsSymlink(session: WtLspSession): Promise<void> {
    const launch = this.launches.get(session.wtPath);
    if (!launch || launch.withoutIndex) return;
    const isSymlink = await indexDirectoryIsSymlink(
      session.wtPath,
      launch.developerTools ? probe : probeWithoutAppleStubs,
      launch.compileCommandsDir,
    );
    if (!isSymlink || !this.isSessionLive(session)) return;
    this.log.info("Restarting: the index directory is now a symlink", { wtPath: session.wtPath });
    this.restart(session, "Index directory changed; reconnect");
  }

  /** The flag and the index apply from a start, so a different answer takes a new session. */
  private restartIfDatabaseDirChanged(session: WtLspSession, status: CompileDatabaseStatus): void {
    const launch = this.launches.get(session.wtPath);
    if (!launch || !this.isSessionLive(session)) return;
    const databaseDir = compileCommandsDir(status);
    const indexLeavesWorktree =
      !session.repoTrusted &&
      databaseDir === null &&
      status.namesOutsideDatabase &&
      !launch.withoutIndex;
    if (launch.compileCommandsDir === databaseDir && !indexLeavesWorktree) return;
    this.log.info("Restarting: the compile database changed", {
      wtPath: session.wtPath,
      databaseDir,
    });
    this.restart(session, "Compile database changed; reconnect");
  }

  private refreshIndex(session: WtLspSession): void {
    const files = this.sessionFiles.get(session);
    const launch = this.launches.get(session.wtPath);
    if (!files || launch?.withoutIndex) return;
    const lastRefresh = this.indexRefreshedAt.get(session.wtPath);
    const untilAllowed =
      lastRefresh === undefined ? 0 : lastRefresh + INDEX_REFRESH_MIN_INTERVAL_MS - Date.now();
    // Kept pending with nothing open, for the file opened next.
    const waitMs = Math.max(
      untilAllowed,
      files.openDocuments.size === 0 ? INDEX_REFRESH_QUIET_MS : 0,
    );
    if (waitMs > 0) {
      files.changes.refreshIndexAfter(waitMs);
      return;
    }
    const passedDatabase =
      launch?.compileCommandsDir && join(launch.compileCommandsDir, "compile_commands.json");
    const hasIndex = passedDatabase
      ? existsSync(passedDatabase)
      : hasCompileDatabase(files.openDocuments.keys());
    if (!hasIndex) return;
    this.indexRefreshedAt.set(session.wtPath, Date.now());
    this.log.info("Restarting: files changed on disk", { wtPath: session.wtPath });
    this.restart(session, "Files changed on disk; reconnect");
  }

  /** The client reconnects at once and opens its documents again. */
  private restart(session: WtLspSession, reason: string): void {
    const { ws } = session;
    this.detach(ws);
    ws.close(LSP_RESTART_CLOSE_CODE, reason);
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    super.handleServerFrame(session, escapeSnippetDollars(body));
  }

  protected override onClientInitialized(session: WtLspSession): void {
    if (this.launches.get(session.wtPath)?.developerTools !== false) return;
    session.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "window/showMessage",
        params: { type: MESSAGE_TYPE_WARNING, message: NO_DEVELOPER_TOOLS_MESSAGE },
      }),
    );
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const env = buildSpawnEnv();
    return {
      ...super.spawnOptions(context),
      env: {
        // In a trusted repository clangd reads the user's config itself, as it would for them.
        ...(context.repoTrusted ? {} : prepareClangdUserConfig(this.stateDir, this.platform, env)),
        // clangd runs `xcrun` at startup to find the SDK, and carries on without it if not on PATH.
        ...(this.launches.get(context.wtPath)?.developerTools === false
          ? { PATH: withoutAppleStubs(env.PATH) }
          : {}),
      },
    };
  }
}
