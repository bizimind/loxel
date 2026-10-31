import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CSharpProjects,
  CSharpRestoreState,
  DotnetRuntime,
  DotnetRuntimes,
  GlobalJsonInfo,
  GlobalJsonSdkPath,
} from "@/api/csharp-env-model";
import { isDirectory } from "@/fs-utils";

import { mapWithConcurrency } from "./git-commands";
import { logger } from "./logger";
import { pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv } from "./shell-env";
import { canGitReadRepo, isInside, isShippedByRepo, runGit } from "./shipped-by-repo";

const log = logger.child("server");

const GLOBAL_JSON = "global.json";
const HOST_SDK_PATH = "$host$";
const DOTNET_TIMEOUT_MS = 15_000;
const SDK_VERSION_RE = /^\d+\.\d+\.\d+\S*$/;
const NETCORE_RUNTIME_RE = /^Microsoft\.NETCore\.App (\S+) \[(.+)\]$/gm;
const MIN_RUNTIME_MAJOR = 10;
/** Quiet period after the last filesystem event before re-reading (restores write in bursts). */
const WATCH_DEBOUNCE_MS = 1000;
/** Far above any real `global.json` or props file; a read of anything larger is refused. */
const MAX_READ_BYTES = 1024 * 1024;
/** Far above any real `sdk.paths`; a file with more counts as invalid. */
const MAX_SDK_PATHS = 64;
/** Checks that spawn git run in a small pool, since their number depends on the repository. */
const GIT_CHECK_CONCURRENCY = 6;
/** How many projects' restored state is watched, to bound open watches in a huge repository. */
const MAX_WATCHED_PROJECTS = 200;

type SpawnEnv = Record<string, string | undefined>;

export interface DotnetOptions {
  /** Environment for `PATH` and `DOTNET_ROOT`. Defaults to the login-shell spawn environment. */
  env?: SpawnEnv;
}

/** Where a `dotnet` will run, for the SDK check. */
export interface DotnetRunOptions extends DotnetOptions {
  cwd?: string;
  /**
   * Check only the `global.json` applying to `cwd`, for a run that starts nothing elsewhere in the
   * worktree. It skips listing them all through git, which a run on every save should not pay for.
   */
  applyingOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Finding dotnet

/**
 * Find `dotnet` for a worktree, without running it: the first on the login-shell `PATH`, else the
 * one in `DOTNET_ROOT_<ARCH>` or `DOTNET_ROOT`. A `dotnet` on `PATH` uses its own install whatever
 * `DOTNET_ROOT` says, as the host does, so `PATH` comes first. The worktree's own directories
 * and anything git tracks do not count. Never throws. To run it, use {@link prepareDotnet}: this
 * says that a `dotnet` exists, not that it may run in the worktree.
 */
export async function resolveDotnet(
  worktreePath: string,
  options: DotnetOptions = {},
): Promise<string | null> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  try {
    for (const dir of pathOutsideWorktree(env.PATH ?? "", wtPath).split(path.delimiter)) {
      const found = await usableDotnetIn(wtPath, dir);
      if (found) return found;
    }
    return await dotnetRootDotnet(wtPath, env);
  } catch (err) {
    log.warn("Looking for dotnet failed", { wtPath, error: err });
    return null;
  }
}

async function usableDotnetIn(wtPath: string, dir: string): Promise<string | null> {
  // A relative entry would depend on the server's directory.
  if (!path.isAbsolute(dir)) return null;
  const dotnet = Bun.which("dotnet", { PATH: dir });
  if (!dotnet) return null;
  // `realpath` so a symlink on PATH that leads back into the worktree does not count either.
  const [realDotnet, realWtPath] = await Promise.all([realpath(dotnet), realpath(wtPath)]);
  if (isInside(realDotnet, realWtPath) || isInside(dotnet, wtPath)) return null;
  return (await isShippedByRepo(wtPath, dotnet)) ? null : dotnet;
}

async function dotnetRootDotnet(wtPath: string, env: SpawnEnv): Promise<string | null> {
  const root = env[`DOTNET_ROOT_${process.arch.toUpperCase()}`] || env.DOTNET_ROOT;
  return root ? usableDotnetIn(wtPath, root) : null;
}

/** A `dotnet` with its spawn environment, for a worktree that passed {@link isDotnetSafeToRun}. */
export interface PreparedDotnet {
  dotnetPath: string;
  env: SpawnEnv;
  /** The directory the check covered: run there. */
  cwd: string;
}

/**
 * The way to get a `dotnet` to run for a worktree: the SDK check runs first, and a null here means
 * nothing may be run, either because no `dotnet` exists or because the check did not pass. Pass
 * `cwd` when `dotnet` will run somewhere below the worktree root. Prepare again before each run.
 */
export async function prepareDotnet(
  worktreePath: string,
  options: DotnetRunOptions = {},
): Promise<PreparedDotnet | null> {
  const env = options.env ?? buildSpawnEnv();
  if (!(await isDotnetSafeToRun(worktreePath, options))) return null;
  const dotnetPath = await resolveDotnet(worktreePath, { env });
  if (!dotnetPath) return null;
  const cwd = options.cwd ?? path.resolve(worktreePath);
  return { dotnetPath, env: dotnetSpawnEnv(worktreePath, env), cwd };
}

function dotnetSpawnEnv(wtPath: string, env: SpawnEnv): SpawnEnv {
  return {
    ...env,
    PATH: pathOutsideWorktree(env.PATH ?? "", path.resolve(wtPath)),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
  };
}

// ---------------------------------------------------------------------------
// global.json, by parsing the file only

/**
 * Whether `dotnet` may run in a worktree. `dotnet` commands that need an SDK load the one
 * `global.json` selects, so this reads the `global.json` that applies to the worktree root (or to
 * `cwd`, when given) and every one git lists below it, and refuses when any `sdk.paths` entry holds
 * something git tracks, or when a file cannot be read unambiguously. Runs nothing but git. Never
 * throws; a failure counts as not safe.
 */
export async function isDotnetSafeToRun(
  worktreePath: string,
  options: DotnetRunOptions = {},
): Promise<boolean> {
  const wtPath = path.resolve(worktreePath);
  try {
    const applying = await findGlobalJson(options.cwd ?? wtPath);
    if (options.applyingOnly) {
      if (!applying) return true;
      const info = await readGlobalJson(wtPath, applying, options);
      if (!isGlobalJsonSafe(info)) return false;
      // A repository git cannot read reports nothing as tracked, which says nothing about `paths`.
      if (!info.sdkPaths?.length) return true;
      return (await canGitReadRepo(wtPath)) || !findFileAbove(".git", wtPath);
    }
    // Later callers run dotnet from project directories, whose global.json can differ.
    // `icase`: on a case-insensitive disk the host opens any casing of the name.
    const listed = await gitListFiles(wtPath, [`:(glob,icase)**/${GLOBAL_JSON}`]);
    // Git failing inside a repository leaves its subfolders unchecked; outside one, none are listed.
    if (listed === null && findFileAbove(".git", wtPath)) return false;
    // Git also lists a tracked file deleted from disk, which applies to nothing.
    const existing = (listed ?? []).filter((file) => existsSync(file));
    const files = new Set([...(applying ? [applying] : []), ...existing]);
    const infos = await mapWithConcurrency([...files], GIT_CHECK_CONCURRENCY, (file) =>
      readGlobalJson(wtPath, file, options),
    );
    return infos.every(isGlobalJsonSafe);
  } catch (err) {
    log.warn("Could not check global.json; treating dotnet as not safe to run", {
      wtPath,
      error: err,
    });
    return false;
  }
}

function isGlobalJsonSafe(info: GlobalJsonInfo): boolean {
  return info.valid && (info.sdkPaths ?? []).every((sdkPath) => !sdkPath.tracked);
}

/**
 * The `global.json` that applies to `dir`, or null. Runs nothing. See {@link findGlobalJson} for
 * which file that is.
 */
export async function inspectGlobalJson(
  worktreePath: string,
  dir: string,
  options: DotnetOptions = {},
): Promise<GlobalJsonInfo | null> {
  const file = await findGlobalJson(dir);
  return file ? readGlobalJson(path.resolve(worktreePath), file, options) : null;
}

/**
 * The nearest `global.json` at or above `dir`, as the .NET host walks: from the physical directory,
 * and stopping at the first one, even if that one is invalid.
 */
async function findGlobalJson(dir: string): Promise<string | null> {
  let current = await realpath(dir);
  for (;;) {
    const candidate = path.join(current, GLOBAL_JSON);
    if (await pathEntryExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readGlobalJson(
  wtPath: string,
  file: string,
  options: DotnetOptions,
): Promise<GlobalJsonInfo> {
  const invalid = { path: file, valid: false, sdkVersion: null, rollForward: null, sdkPaths: null };
  let sdk: Record<string, unknown>;
  try {
    const parsed = parseGlobalJson(await readSmallFile(file));
    if (!isRecord(parsed)) return invalid;
    if (parsed.sdk === undefined || parsed.sdk === null) {
      return { ...invalid, valid: true };
    }
    if (!isRecord(parsed.sdk)) return invalid;
    sdk = parsed.sdk;
  } catch {
    return invalid;
  }
  const { version, rollForward, paths } = sdk;
  if (version !== undefined && version !== null && typeof version !== "string") return invalid;
  if (rollForward !== undefined && rollForward !== null && typeof rollForward !== "string") {
    return invalid;
  }
  if (paths !== undefined && paths !== null && !Array.isArray(paths)) return invalid;
  // The host's base for relative entries is the directory the file was found in, not a symlink's target.
  const baseDir = path.dirname(file);
  // The host skips entries that are not strings.
  const entries = (paths ?? []).filter((entry): entry is string => typeof entry === "string");
  if (entries.length > MAX_SDK_PATHS) return invalid;
  return {
    path: file,
    valid: true,
    sdkVersion: version ?? null,
    rollForward: rollForward ?? null,
    sdkPaths: paths
      ? await mapWithConcurrency(entries, GIT_CHECK_CONCURRENCY, (entry) =>
          inspectSdkPath(wtPath, baseDir, entry, options),
        )
      : null,
  };
}

const JSON_STRING_MAYBE_KEY = /("(?:[^"\\]|\\.)*")(\s*:)?/g;
/** The keys this module reads; for a repeated key the host takes the first, `JSON.parse` the last. */
const SINGLE_KEYS = new Set(["sdk", "version", "rollForward", "paths"]);

/**
 * Parse a `global.json` as the host's parser reads it (a BOM and comments allowed). Throws on
 * anything stricter JSON parsing rejects, and on a repeated key this module reads, so anything
 * it could read differently from the host counts as invalid rather than as a clean answer.
 */
function parseGlobalJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const stripped = stripJsonComments(text);
  // First, so the scan for keys below only sees balanced strings.
  const parsed: unknown = JSON.parse(stripped);
  const seen = new Set<string>();
  for (const [, token, colon] of stripped.matchAll(JSON_STRING_MAYBE_KEY)) {
    if (!colon) continue;
    const key: unknown = JSON.parse(token!);
    if (typeof key !== "string" || !SINGLE_KEYS.has(key)) continue;
    if (seen.has(key)) throw new Error(`Repeated key in global.json: ${key}`);
    seen.add(key);
  }
  return parsed;
}

/** One pass over the text, so the time taken stays linear in its size. Throws on an open comment. */
function stripJsonComments(text: string): string {
  const kept: string[] = [];
  let keptFrom = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      i = endOfJsonString(text, i);
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      const isLine = text[i + 1] === "/";
      const end = text.indexOf(isLine ? "\n" : "*/", i + 2);
      if (end === -1 && !isLine) throw new Error("Unterminated comment in global.json");
      kept.push(text.slice(keptFrom, i), " ");
      if (end === -1) i = text.length;
      else i = isLine ? end : end + 2;
      keptFrom = i;
    } else {
      i++;
    }
  }
  kept.push(text.slice(keptFrom));
  return kept.join("");
}

function endOfJsonString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

async function inspectSdkPath(
  wtPath: string,
  baseDir: string,
  entry: string,
  options: DotnetOptions,
): Promise<GlobalJsonSdkPath> {
  if (entry === HOST_SDK_PATH) {
    // The install of the dotnet about to run, which `resolveDotnet` already held to the same rule.
    const dotnet = await resolveDotnet(wtPath, options);
    const host = dotnet ? path.dirname(await realpath(dotnet)) : null;
    return { entry, path: host, insideWorktree: false, tracked: false };
  }
  // Not normalized: the host hands the path to the OS, for which `link/..` is the link's target's parent.
  const raw = path.isAbsolute(entry) ? entry : `${baseDir}${path.sep}${entry}`;
  const physical = await realpath(raw).catch(() => null);
  const lexical = path.resolve(raw);
  const realWtPath = await realpath(wtPath).catch(() => wtPath);
  // The host looks in `<entry>/sdk`, which an entry holding the worktree can make a tracked directory.
  const holdsWorktree = physical !== null && isInside(realWtPath, physical);
  return {
    entry,
    path: physical ?? lexical,
    insideWorktree: isInside(lexical, wtPath) || isInside(physical ?? lexical, realWtPath),
    tracked: holdsWorktree || (await isSdkPathTracked(wtPath, raw, physical)),
  };
}

/**
 * Whether git tracks something at an `sdk.paths` entry or a symlink on the way to it. An entry that
 * does not exist holds nothing (`.dotnet` before the build script installed it). This is the
 * "Environment trust rule" of `docs/languages/python.md`: what a build script installed is
 * untracked, and what is tracked is repository content.
 */
async function isSdkPathTracked(
  wtPath: string,
  raw: string,
  physical: string | null,
): Promise<boolean> {
  try {
    for (const prefix of pathPrefixes(raw)) {
      // A symlink to the worktree itself (opened through a link) holds its files but is not one of them.
      if (isInside(wtPath, prefix)) continue;
      const info = await lstat(prefix).catch(() => null);
      if (info?.isSymbolicLink() && (await isShippedByRepo(wtPath, prefix))) return true;
    }
    if (!(await pathEntryExists(raw))) return false;
    return await isShippedByRepo(wtPath, physical ?? raw);
  } catch {
    return true;
  }
}

/** Every prefix of an unnormalized absolute path, the path itself included. */
function pathPrefixes(raw: string): string[] {
  const segments = raw.split(path.sep);
  return segments.slice(1).map((_, i) => segments.slice(0, i + 2).join(path.sep));
}

// ---------------------------------------------------------------------------
// SDK and runtime versions

/** Stamps by the command's inputs; a failed read is not cached, so it is retried next time. */
const sdkVersions = new Map<string, Promise<string | null>>();
const runtimeLists = new Map<string, Promise<DotnetRuntime[] | null>>();

/**
 * The SDK `dotnet --version` reports in `cwd` (default the worktree root), which honors
 * `global.json`, or null: no `dotnet`, the SDK check did not pass, or no SDK matches. The check
 * runs on every call, before the cache is read. Cached until `dotnet`, its SDKs or the
 * applying `global.json` change.
 */
export async function dotnetSdkVersion(
  worktreePath: string,
  options: DotnetOptions & { cwd?: string } = {},
): Promise<string | null> {
  const wtPath = path.resolve(worktreePath);
  const prepared = await prepareDotnet(wtPath, options);
  if (!prepared) return null;
  const { dotnetPath, env, cwd } = prepared;
  const key = await sdkVersionKey(wtPath, dotnetPath, cwd, options);
  if (!key) return null;
  return cachedRead(sdkVersions, key, async () => {
    const output = await runDotnet(dotnetPath, ["--version"], cwd, env);
    const version = output?.trim() ?? "";
    return SDK_VERSION_RE.test(version) ? version : null;
  });
}

async function sdkVersionKey(
  wtPath: string,
  dotnetPath: string,
  cwd: string,
  options: DotnetOptions,
): Promise<string | null> {
  const install = path.dirname(await realpath(dotnetPath).catch(() => dotnetPath));
  const file = await findGlobalJson(cwd).catch(() => null);
  const info = file ? await readGlobalJson(wtPath, file, options) : null;
  const sdkDirs = (info?.sdkPaths ?? []).flatMap((sdkPath) =>
    sdkPath.path ? [path.join(sdkPath.path, "sdk")] : [],
  );
  const dotnetStamp = await fileStamp(dotnetPath);
  if (!dotnetStamp) return null;
  const stamps = await Promise.all(
    [path.join(install, "sdk"), ...(file ? [file] : []), ...sdkDirs].map(
      async (input) => `${input}:${(await fileStamp(input)) ?? "missing"}`,
    ),
  );
  return [dotnetPath, dotnetStamp, cwd, ...stamps].join("\0");
}

/**
 * The runtimes of the `dotnet` on `PATH` and of the install under `DOTNET_ROOT`, from
 * `dotnet --list-runtimes`, which each reports for its own install only. It loads no SDK and runs
 * from a directory outside the worktree, so it does not need the SDK check. Null without any
 * `dotnet`. Each install's list is cached until its runtimes change.
 */
export async function dotnetRuntimes(
  worktreePath: string,
  options: DotnetOptions = {},
): Promise<DotnetRuntimes | null> {
  const wtPath = path.resolve(worktreePath);
  const env = options.env ?? buildSpawnEnv();
  try {
    const onPath = await resolveDotnet(wtPath, { env });
    const underRoot = await dotnetRootDotnet(wtPath, env);
    // One per install: a `dotnet` on PATH is commonly a symlink into the DOTNET_ROOT install.
    const found = [underRoot, onPath].filter((dotnet) => dotnet !== null);
    if (found.length === 0) return null;
    const installs = new Set(await Promise.all(found.map((dotnet) => realpath(dotnet))));
    const lists = await Promise.all(
      [...installs].map((dotnet) => listRuntimes(wtPath, dotnet, env)),
    );
    const runtimes = lists.flatMap((list) => list ?? []);
    const modern = runtimes.find((runtime) => majorOf(runtime.version) >= MIN_RUNTIME_MAJOR);
    return { runtimes, runtime10Root: modern?.root ?? null };
  } catch (err) {
    log.debug("Could not list .NET runtimes", { wtPath, error: err });
    return null;
  }
}

async function listRuntimes(
  wtPath: string,
  dotnet: string,
  env: SpawnEnv,
): Promise<DotnetRuntime[] | null> {
  const install = path.dirname(await realpath(dotnet));
  const [dotnetStamp, runtimesStamp] = await Promise.all([
    fileStamp(dotnet),
    fileStamp(path.join(install, "shared", "Microsoft.NETCore.App")),
  ]);
  const key = [dotnet, dotnetStamp, runtimesStamp].join("\0");
  return cachedRead(runtimeLists, key, async () => {
    const output = await runDotnet(
      dotnet,
      ["--list-runtimes"],
      tmpdir(),
      dotnetSpawnEnv(wtPath, env),
    );
    if (output === null) return null;
    return [...output.matchAll(NETCORE_RUNTIME_RE)].map(([, version, dir]) => ({
      version: version!,
      root: path.dirname(path.dirname(dir!)),
    }));
  });
}

function majorOf(version: string): number {
  return Number.parseInt(version, 10);
}

function cachedRead<T>(
  cache: Map<string, Promise<T | null>>,
  key: string,
  read: () => Promise<T | null>,
): Promise<T | null> {
  const known = cache.get(key);
  if (known) return known;
  const value = read();
  cache.set(key, value);
  // A failed read (a timeout while the OS scans a fresh binary) is retried next time.
  void value.then((result) => {
    if (result === null) cache.delete(key);
  });
  return value;
}

/** The output of a `dotnet` command that exited with 0, else null. Callers made sure it may run. */
async function runDotnet(
  dotnetPath: string,
  args: string[],
  cwd: string,
  env: SpawnEnv,
): Promise<string | null> {
  try {
    const proc = Bun.spawn([dotnetPath, ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: DOTNET_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? stdout : null;
  } catch (err) {
    log.debug("Could not run dotnet", { dotnetPath, args, error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project discovery

const SOLUTION_EXTENSIONS = new Set([".sln", ".slnx"]);
const SOLUTION_FILTER_EXTENSION = ".slnf";
const PROJECT_EXTENSION = ".csproj";
const DISCOVERED_EXTENSIONS = [
  ...SOLUTION_EXTENSIONS,
  SOLUTION_FILTER_EXTENSION,
  PROJECT_EXTENSION,
];

/**
 * The worktree's solutions and projects, listed through git so ignored trees (`bin`, `obj`,
 * vendored directories) are skipped, and the default load target. A worktree in no git repository
 * lists its root only. Never throws.
 */
export async function discoverCSharpProjects(worktreePath: string): Promise<CSharpProjects> {
  const wtPath = path.resolve(worktreePath);
  const patterns = DISCOVERED_EXTENSIONS.map((extension) => `:(glob)**/*${extension}`);
  const listed = (await gitListFiles(wtPath, patterns)) ?? rootEntries(wtPath);
  const files = listed.filter((file) => existsSync(file)).toSorted();
  const solutions = files.filter((file) => SOLUTION_EXTENSIONS.has(path.extname(file)));
  const solutionFilters = files.filter((file) => path.extname(file) === SOLUTION_FILTER_EXTENSION);
  const projects = files.filter((file) => path.extname(file) === PROJECT_EXTENSION);
  const rootSolutions = solutions.filter((file) => path.dirname(file) === wtPath);
  let defaultTarget: CSharpProjects["defaultTarget"] = null;
  if (rootSolutions.length === 1) defaultTarget = { kind: "solution", path: rootSolutions[0]! };
  else if (projects.length > 0) defaultTarget = { kind: "projects", paths: projects };
  return { solutions, solutionFilters, projects, defaultTarget };
}

function rootEntries(wtPath: string): string[] {
  try {
    return readdirSync(wtPath)
      .filter((name) => DISCOVERED_EXTENSIONS.includes(path.extname(name)))
      .map((name) => path.join(wtPath, name));
  } catch {
    return [];
  }
}

/** Tracked and untracked but not ignored files, as absolute paths; null when git cannot answer. */
async function gitListFiles(wtPath: string, patterns: string[]): Promise<string[] | null> {
  const { exitCode, stdout } = await runGit(wtPath, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...patterns,
  ]);
  if (exitCode !== 0) return null;
  return [...new Set(stdout.split("\0").filter(Boolean))].map((file) => path.join(wtPath, file));
}

// ---------------------------------------------------------------------------
// Restored state, reading files only (projects are not evaluated)

const PROPS_FILE = "Directory.Build.props";
const OBJ_DIR = "obj";
const ASSETS_FILE = "project.assets.json";
const MAX_IMPORT_DEPTH = 8;
/** Properties that move restore's output in a way this module does not follow. */
const UNFOLLOWED_LAYOUT_PROPS = new Set([
  "baseintermediateoutputpath",
  "msbuildprojectextensionspath",
  "restoreoutputpath",
  "artifactsprojectname",
  "includeprojectnameinartifactspaths",
  "importdirectorybuildprops",
]);
const USE_ARTIFACTS_PROP = "useartifactsoutput";
const ARTIFACTS_PATH_PROP = "artifactspath";
const THIS_FILE_DIR = /\$\(MSBuildThisFileDirectory\)/gi;
const FILE_ABOVE_IMPORT =
  /^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*'([^'$]+)'\s*,\s*'\$\(MSBuildThisFileDirectory\)([^'$]*)'\s*\)\)$/i;

/** Whether the project has been restored: its assets file exists and git does not track it. */
export async function csharpRestoreState(
  worktreePath: string,
  projectPath: string,
): Promise<CSharpRestoreState> {
  const wtPath = path.resolve(worktreePath);
  const project = path.resolve(projectPath);
  return restoreStateFrom(wtPath, project, await readRestoreLayout(project));
}

async function restoreStateFrom(
  wtPath: string,
  project: string,
  { assetsPath }: RestoreLayout,
): Promise<CSharpRestoreState> {
  return {
    project,
    assetsPath,
    restored: assetsPath ? await isUntrackedFile(wtPath, assetsPath) : false,
  };
}

function readRestoreLayout(project: string): Promise<RestoreLayout> {
  return restoreLayout(project).catch(() => ({ assetsPath: null, inputs: [project] }));
}

async function isUntrackedFile(wtPath: string, file: string): Promise<boolean> {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  return !(await isShippedByRepo(wtPath, file));
}

/** A project's restore output, and the files that decide it, which are worth watching. */
interface RestoreLayout {
  /** Null when the files do not settle where restore writes. */
  assetsPath: string | null;
  inputs: string[];
}

/** One property set in a props file. */
interface PropSetting {
  name: string;
  value: string;
  /** Under a `Condition` that is not evaluated. */
  conditional: boolean;
  /** The file it was set in, for `$(MSBuildThisFileDirectory)`. */
  file: string;
}

async function restoreLayout(project: string): Promise<RestoreLayout> {
  const projectDir = path.dirname(project);
  const defaultAssets = path.join(projectDir, OBJ_DIR, ASSETS_FILE);
  const propsFile = findFileAbove(PROPS_FILE, projectDir);
  const inputs = [project];
  const undetermined = (): RestoreLayout => ({ assetsPath: null, inputs });

  // The SDK reads these before the project body, so a project setting them is not followed.
  const projectSettings = scanPropertyGroups(await readSmallText(project), project);
  if (projectSettings?.length !== 0) return undetermined();
  if (!propsFile) return { assetsPath: defaultAssets, inputs };

  const settings = await readPropsFile(propsFile, new Set(), 0, inputs);
  if (!settings) return undetermined();
  if (settings.some((setting) => UNFOLLOWED_LAYOUT_PROPS.has(setting.name))) return undetermined();

  const useArtifacts = settings.filter((setting) => setting.name === USE_ARTIFACTS_PROP);
  const artifactsPaths = settings.filter((setting) => setting.name === ARTIFACTS_PATH_PROP);
  if ([...useArtifacts, ...artifactsPaths].some((setting) => setting.conditional)) {
    return undetermined();
  }
  const enabled = new Set(useArtifacts.map((setting) => setting.value.toLowerCase()));
  if (enabled.size > 1 || [...enabled].some((value) => value !== "true" && value !== "false")) {
    return undetermined();
  }
  if (artifactsPaths.length > 1) return undetermined();
  const artifactsPath = artifactsPaths[0];
  if (enabled.has("false")) {
    return artifactsPath ? undetermined() : { assetsPath: defaultAssets, inputs };
  }
  if (!artifactsPath && !enabled.has("true")) return { assetsPath: defaultAssets, inputs };

  const artifactsDir = artifactsPath
    ? expandArtifactsPath(artifactsPath, projectDir)
    : path.join(path.dirname(propsFile), "artifacts");
  if (!artifactsDir) return undetermined();
  const projectName = path.basename(project, path.extname(project));
  return { assetsPath: path.join(artifactsDir, OBJ_DIR, projectName, ASSETS_FILE), inputs };
}

function isLayoutProp(name: string): boolean {
  return (
    UNFOLLOWED_LAYOUT_PROPS.has(name) || name === USE_ARTIFACTS_PROP || name === ARTIFACTS_PATH_PROP
  );
}

/** A literal path, or one using only `$(MSBuildThisFileDirectory)`; relative to the project. */
function expandArtifactsPath(setting: PropSetting, projectDir: string): string | null {
  const expanded = setting.value
    .trim()
    .replace(THIS_FILE_DIR, `${path.dirname(setting.file)}/`)
    .replaceAll("\\", "/");
  if (!expanded || expanded.includes("$(") || expanded.includes("&")) return null;
  return path.resolve(projectDir, expanded);
}

/**
 * The property settings of a props file and the files it imports, or null when an import cannot be
 * followed from the file alone, since it could change anything. Adds every file read to `inputs`.
 */
async function readPropsFile(
  file: string,
  visited: Set<string>,
  depth: number,
  inputs: string[],
): Promise<PropSetting[] | null> {
  if (visited.has(file)) return [];
  if (depth > MAX_IMPORT_DEPTH) return null;
  visited.add(file);
  inputs.push(file);
  const text = stripXmlComments(await readSmallText(file));
  const tags = scanXmlTags(text);
  if (!tags || hasUnfollowedImports(tags)) return null;

  const settings = scanPropertyGroups(text, file);
  if (!settings) return null;
  for (const { name, closing, attributes } of tags) {
    if (name !== "import" || closing) continue;
    const project = xmlAttribute(attributes, "Project");
    const conditional = xmlAttribute(attributes, "Condition") !== null;
    if (xmlAttribute(attributes, "Sdk") !== null || !project) return null;
    const imported = resolveImport(project, file);
    if (imported === null) return null;
    // `GetPathOfFileAbove` found nothing, or a conditional import of a file that is not there.
    if (imported === undefined || (conditional && !(await Bun.file(imported).exists()))) continue;
    if (!(await Bun.file(imported).exists())) return null;
    const nested = await readPropsFile(imported, visited, depth + 1, inputs);
    if (!nested) return null;
    settings.push(
      ...nested.map((setting) => ({ ...setting, conditional: setting.conditional || conditional })),
    );
  }
  return settings;
}

/** An import's absolute path; undefined when it searches upward and finds nothing; null when not static. */
function resolveImport(project: string, file: string): string | null | undefined {
  const fileDir = path.dirname(file);
  const above = FILE_ABOVE_IMPORT.exec(project.trim());
  if (above) {
    const start = path.resolve(fileDir, above[2]!.replaceAll("\\", "/"));
    return findFileAbove(above[1]!, start) ?? undefined;
  }
  const expanded = project.trim().replace(THIS_FILE_DIR, `${fileDir}/`).replaceAll("\\", "/");
  if (expanded.includes("$(") || expanded.includes("*")) return null;
  return path.resolve(fileDir, expanded);
}

function findFileAbove(name: string, startDir: string): string | null {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `Sdk` imports, and imports under a condition or a `Choose`, which this module does not follow. */
function hasUnfollowedImports(tags: XmlTag[]): boolean {
  let inChoose = false;
  for (const { name, closing, attributes } of tags) {
    if (closing) continue;
    if (name === "choose") inChoose = true;
    if (name === "sdk" || (name === "import" && inChoose)) return true;
    if (name === "project" && xmlAttribute(attributes, "Sdk") !== null) return true;
    if (name === "importgroup" && xmlAttribute(attributes, "Condition") !== null) return true;
  }
  return false;
}

/**
 * The layout properties set in a file, or null when it mentions one in a way this scan does not
 * read (a `Choose`, a `Target`, CDATA, a nested or self-closed element).
 */
function scanPropertyGroups(source: string, file: string): PropSetting[] | null {
  const text = stripXmlComments(source);
  const tags = scanXmlTags(text);
  if (!tags) return null;
  const mentions = tags.filter((tag) => !tag.closing && isLayoutProp(tag.name)).length;
  if (mentions === 0) return [];
  if (text.includes("<![CDATA[") || text.includes("<!--")) return null;
  if (tags.some((tag) => tag.name === "choose" || tag.name === "target")) return null;

  const settings: PropSetting[] = [];
  let inGroup = false;
  let groupConditional = false;
  for (const [i, tag] of tags.entries()) {
    if (tag.name === "propertygroup") {
      if (tag.selfClosed) continue;
      inGroup = !tag.closing;
      groupConditional = inGroup && hasCondition(tag);
      continue;
    }
    const next = tags[i + 1];
    if (!inGroup || tag.closing || tag.selfClosed || !isLayoutProp(tag.name)) continue;
    if (!next?.closing || next.name !== tag.name) continue;
    settings.push({
      name: tag.name,
      value: text.slice(tag.end, next.start).trim(),
      conditional: groupConditional || hasCondition(tag),
      file,
    });
  }
  return settings.length === mentions ? settings : null;
}

function hasCondition(tag: XmlTag): boolean {
  return /\bCondition\s*=/i.test(tag.attributes);
}

/** One XML tag, with the offsets of its `<` and of what follows its `>`. */
interface XmlTag {
  /** Lower-cased, since MSBuild property names are case-insensitive. */
  name: string;
  closing: boolean;
  selfClosed: boolean;
  attributes: string;
  start: number;
  end: number;
}

/**
 * The tags of a file, quote-aware since an attribute value may contain `>`, or null when a tag does
 * not end. One pass over the text, so the time taken stays linear in its size.
 */
function scanXmlTags(text: string): XmlTag[] | null {
  const tags: XmlTag[] = [];
  let at = text.indexOf("<");
  while (at !== -1) {
    const closing = text[at + 1] === "/";
    const nameStart = at + (closing ? 2 : 1);
    let i = nameStart;
    while (i < text.length && /[\w.-]/.test(text[i]!)) i++;
    if (i === nameStart) {
      // A declaration, a processing instruction or a stray `<`.
      at = text.indexOf("<", at + 1);
      continue;
    }
    const attributesStart = i;
    let quote: string | null = null;
    for (; i < text.length && (quote || text[i] !== ">"); i++) {
      const char = text[i]!;
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      }
    }
    if (i >= text.length) return null;
    tags.push({
      name: text.slice(nameStart, attributesStart).toLowerCase(),
      closing,
      selfClosed: text[i - 1] === "/",
      attributes: text.slice(attributesStart, i),
      start: at,
      end: i + 1,
    });
    at = text.indexOf("<", i + 1);
  }
  return tags;
}

/** One pass over the text; what removing a comment leaves behind is never read as a new one. */
function stripXmlComments(text: string): string {
  const kept: string[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    const close = open === -1 ? -1 : text.indexOf("-->", open + 4);
    if (close === -1) break;
    kept.push(text.slice(at, open));
    at = close + 3;
  }
  kept.push(text.slice(at));
  return kept.join("");
}

function xmlAttribute(element: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(element);
  return match ? (match[1] ?? match[2] ?? "") : null;
}

// ---------------------------------------------------------------------------
// Watching the restored state

/** What a {@link subscribeCSharpRestore} listener hears. */
export interface CSharpRestoreUpdate {
  /** The restored state of every project in the worktree. */
  states: CSharpRestoreState[];
  /** The first read since the worktree was subscribed; later updates mean something changed. */
  first: boolean;
}

interface WorktreeRestoreWatch {
  listeners: Set<(update: CSharpRestoreUpdate) => void>;
  /** Directory watches, with the directory's identity so a recreated one is watched afresh. */
  watchers: Map<string, { watcher: FSWatcher; ino: number }>;
  /** Entry names that matter per watched directory. */
  targets: Map<string, Set<string>>;
  timer: ReturnType<typeof setTimeout> | null;
  /** A read is running; a change meanwhile sets {@link WorktreeRestoreWatch.readAgain}. */
  reading: boolean;
  readAgain: boolean;
  /** The last states told to listeners. */
  last: CSharpRestoreState[] | null;
}

const restoreWatches = new Map<string, WorktreeRestoreWatch>();

/**
 * Keep watching whether the worktree's projects are restored, and call `listener` with the first
 * read and after each change (`dotnet restore` in a terminal, a removed `obj`). `obj` and
 * `artifacts` are git-ignored, so the worktree file watcher does not report them; this module
 * watches them itself, without recursing. Returns the unsubscribe function; the watch goes with
 * the last subscriber.
 */
export function subscribeCSharpRestore(
  worktreePath: string,
  listener: (update: CSharpRestoreUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  let entry = restoreWatches.get(wtPath);
  if (!entry) {
    entry = {
      listeners: new Set(),
      watchers: new Map(),
      targets: new Map(),
      timer: null,
      reading: false,
      readAgain: false,
      last: null,
    };
    restoreWatches.set(wtPath, entry);
    void readRestoreStates(wtPath, entry);
  } else if (entry.last) {
    const known = { states: entry.last, first: true };
    const joined = entry;
    // Not from inside subscribe: the caller has no unsubscribe function yet.
    queueMicrotask(() => {
      if (joined.listeners.has(listener)) notifyRestoreListener(wtPath, listener, known);
    });
  }
  const subscribed = entry;
  subscribed.listeners.add(listener);
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size > 0 || restoreWatches.get(wtPath) !== subscribed) return;
    if (subscribed.timer) clearTimeout(subscribed.timer);
    for (const { watcher } of subscribed.watchers.values()) watcher.close();
    restoreWatches.delete(wtPath);
  };
}

/** Read a subscribed worktree's projects again now, e.g. after a `.csproj` was added or removed. */
export function refreshCSharpRestore(worktreePath: string): void {
  const wtPath = path.resolve(worktreePath);
  const entry = restoreWatches.get(wtPath);
  if (entry) void readRestoreStates(wtPath, entry);
}

/** One read at a time, so a steady stream of changes cannot keep every read from finishing. */
async function readRestoreStates(wtPath: string, entry: WorktreeRestoreWatch): Promise<void> {
  if (entry.reading) {
    entry.readAgain = true;
    return;
  }
  entry.reading = true;
  do {
    entry.readAgain = false;
    await readRestoreStatesOnce(wtPath, entry);
  } while (entry.readAgain && restoreWatches.get(wtPath) === entry);
  entry.reading = false;
}

async function readRestoreStatesOnce(wtPath: string, entry: WorktreeRestoreWatch): Promise<void> {
  const isCurrent = () => restoreWatches.get(wtPath) === entry;
  try {
    const { projects } = await discoverCSharpProjects(wtPath);
    const layouts = await mapWithConcurrency(projects, GIT_CHECK_CONCURRENCY, readRestoreLayout);
    if (!isCurrent()) return;
    // Armed before reading, so a change made while reading schedules another read.
    armRestoreWatches(wtPath, entry, layouts);
    const states = await mapWithConcurrency(
      projects.map((project, index) => ({ project, layout: layouts[index]! })),
      GIT_CHECK_CONCURRENCY,
      ({ project, layout }) => restoreStateFrom(wtPath, project, layout),
    );
    if (!isCurrent()) return;
    if (JSON.stringify(states) === JSON.stringify(entry.last)) return;
    const first = entry.last === null;
    entry.last = states;
    for (const listener of entry.listeners) {
      notifyRestoreListener(wtPath, listener, { states, first });
    }
  } catch (err) {
    log.warn("Reading the C# restored state failed", { wtPath, error: err });
  }
}

/** One failing listener must not keep the update from the others. */
function notifyRestoreListener(
  wtPath: string,
  listener: (update: CSharpRestoreUpdate) => void,
  update: CSharpRestoreUpdate,
): void {
  try {
    listener(update);
  } catch (err) {
    log.warn("A C# restore listener failed", { wtPath, error: err });
  }
}

function armRestoreWatches(
  wtPath: string,
  entry: WorktreeRestoreWatch,
  layouts: RestoreLayout[],
): void {
  if (layouts.length > MAX_WATCHED_PROJECTS) {
    log.debug("Watching the restored state of only some C# projects", {
      wtPath,
      projects: layouts.length,
    });
  }
  entry.targets = restoreWatchTargets(wtPath, layouts.slice(0, MAX_WATCHED_PROJECTS));
  const schedule = () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void readRestoreStates(wtPath, entry);
    }, WATCH_DEBOUNCE_MS);
  };

  for (const [dir, current] of entry.watchers) {
    if (entry.targets.has(dir) && directoryIno(dir) === current.ino) continue;
    current.watcher.close();
    entry.watchers.delete(dir);
  }
  for (const dir of entry.targets.keys()) {
    if (entry.watchers.has(dir)) continue;
    const ino = directoryIno(dir);
    if (ino === null) continue;
    try {
      const watcher = watch(dir, (_event, filename) => {
        // A null filename means the platform could not say what changed; treat it as relevant.
        if (filename === null || entry.targets.get(dir)?.has(filename)) schedule();
      });
      watcher.on("error", (err) => {
        log.debug("C# restore watch failed", { dir, error: err });
        // Dropped so the read this schedules watches the directory afresh.
        watcher.close();
        if (entry.watchers.get(dir)?.watcher === watcher) entry.watchers.delete(dir);
        schedule();
      });
      entry.watchers.set(dir, { watcher, ino });
    } catch (err) {
      log.debug("Could not watch for C# restore changes", { dir, error: err });
    }
  }
}

/**
 * Directories to watch, each with the entry names that matter there: the assets file's directory
 * and the entry for that directory in its parent, or for a missing one the deepest existing
 * ancestor; the files that decide the layout; and every directory from the project up to the root for new props files.
 */
function restoreWatchTargets(wtPath: string, layouts: RestoreLayout[]): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  const add = (dir: string, name: string) => {
    const names = targets.get(dir);
    if (names) names.add(name);
    else targets.set(dir, new Set([name]));
  };
  add(wtPath, PROPS_FILE);
  for (const { assetsPath, inputs } of layouts) {
    for (const input of inputs) add(path.dirname(input), path.basename(input));
    for (let dir = path.dirname(inputs[0]!); isInside(dir, wtPath); dir = path.dirname(dir)) {
      add(dir, PROPS_FILE);
      if (dir === wtPath) break;
    }
    if (!assetsPath) continue;
    let missing = assetsPath;
    while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
      missing = path.dirname(missing);
    }
    add(path.dirname(missing), path.basename(missing));
    if (missing === assetsPath) {
      const assetsDir = path.dirname(assetsPath);
      add(path.dirname(assetsDir), path.basename(assetsDir));
    }
  }
  return targets;
}

function directoryIno(dir: string): number | null {
  try {
    return statSync(dir).ino;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** A regular file's content; throws for anything else, such as a symlink to a device. */
async function readSmallFile(file: string): Promise<Uint8Array> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_READ_BYTES) {
    throw new Error(`Not a regular file of a readable size: ${file}`);
  }
  return Bun.file(file).bytes();
}

async function readSmallText(file: string): Promise<string> {
  return new TextDecoder().decode(await readSmallFile(file));
}

async function pathEntryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if (isRecord(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return false;
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identity of a file or directory, or null when it is missing. */
async function fileStamp(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}
