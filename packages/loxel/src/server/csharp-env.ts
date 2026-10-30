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

import { readOnlyGitEnv } from "./git-commands";
import { logger } from "./logger";
import { isShippedByRepo, pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv } from "./shell-env";

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
/** How many projects' restored state is watched, to bound open watches in a huge repository. */
const MAX_WATCHED_PROJECTS = 200;

type SpawnEnv = Record<string, string | undefined>;

export interface DotnetOptions {
  /** Environment for `PATH` and `DOTNET_ROOT`. Defaults to the login-shell spawn environment. */
  env?: SpawnEnv;
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
  options: DotnetOptions & { cwd?: string } = {},
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
  options: DotnetOptions & { cwd?: string } = {},
): Promise<boolean> {
  const wtPath = path.resolve(worktreePath);
  try {
    const applying = await findGlobalJson(options.cwd ?? wtPath);
    // Later callers run dotnet from project directories, whose global.json can differ.
    // `icase`: on a case-insensitive disk the host opens any casing of the name.
    const listed = await gitListFiles(wtPath, [`:(glob,icase)**/${GLOBAL_JSON}`]);
    // Git failing inside a repository leaves its subfolders unchecked; outside one, none are listed.
    if (listed === null && findFileAbove(".git", wtPath)) return false;
    // Git also lists a tracked file deleted from disk, which applies to nothing.
    const existing = (listed ?? []).filter((file) => existsSync(file));
    const files = new Set([...(applying ? [applying] : []), ...existing]);
    const infos = await Promise.all(
      [...files].map((file) => readGlobalJson(wtPath, file, options)),
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
  return {
    path: file,
    valid: true,
    sdkVersion: version ?? null,
    rollForward: rollForward ?? null,
    sdkPaths: paths
      ? await Promise.all(entries.map((entry) => inspectSdkPath(wtPath, baseDir, entry, options)))
      : null,
  };
}

/** Strings and comments, matched together so a `//` inside a string is left alone. */
const JSON_STRING_OR_COMMENT = /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
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
  const stripped = text.replace(JSON_STRING_OR_COMMENT, (match) =>
    match.startsWith('"') ? match : " ",
  );
  const seen = new Set<string>();
  for (const [, token, colon] of stripped.matchAll(JSON_STRING_MAYBE_KEY)) {
    if (!colon) continue;
    const key: unknown = JSON.parse(token!);
    if (typeof key !== "string" || !SINGLE_KEYS.has(key)) continue;
    if (seen.has(key)) throw new Error(`Repeated key in global.json: ${key}`);
    seen.add(key);
  }
  return JSON.parse(stripped);
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
    const dotnets = [...new Set([underRoot, onPath])].filter((dotnet) => dotnet !== null);
    if (dotnets.length === 0) return null;
    const lists = await Promise.all(dotnets.map((dotnet) => listRuntimes(wtPath, dotnet, env)));
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
  try {
    const proc = Bun.spawn(
      [
        "git",
        "-C",
        wtPath,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...patterns,
      ],
      { env: readOnlyGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return [...new Set(stdout.split("\0").filter(Boolean))].map((file) => path.join(wtPath, file));
  } catch {
    return null;
  }
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
const LAYOUT_PROP_MENTION = new RegExp(
  `<(${[...UNFOLLOWED_LAYOUT_PROPS, USE_ARTIFACTS_PROP, ARTIFACTS_PATH_PROP].join("|")})\\b`,
  "gi",
);
/** A tag's attributes, quote-aware since an attribute value may contain `>`. */
const XML_ATTRIBUTES = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const SELF_CLOSED_GROUP = new RegExp(`<PropertyGroup\\b${XML_ATTRIBUTES}/>`, "gi");
const PROPERTY_GROUP = new RegExp(
  `<PropertyGroup\\b(${XML_ATTRIBUTES})>([\\s\\S]*?)</PropertyGroup\\s*>`,
  "gi",
);
const PROPERTY_ELEMENT = new RegExp(`<([\\w.-]+)\\b(${XML_ATTRIBUTES})>([^<]*)</\\1\\s*>`, "g");
const IMPORT_ELEMENT = new RegExp(`<Import\\b${XML_ATTRIBUTES}>`, "gi");
/** `Sdk` imports, and imports under a condition or a `Choose`, which this module does not follow. */
const UNFOLLOWED_IMPORTS = new RegExp(
  `<Project\\b${XML_ATTRIBUTES}\\bSdk\\s*=|<Sdk\\b|<ImportGroup\\b${XML_ATTRIBUTES}\\bCondition\\s*=|<Choose\\b[\\s\\S]*<Import\\b`,
  "i",
);
/** Constructs whose properties are not plain evaluation-time settings. */
const UNSCANNED_CONSTRUCT = /<(Choose|Target)\b|<!\[CDATA\[/i;
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
  const { assetsPath } = await restoreLayout(project).catch(() => ({ assetsPath: null }));
  return {
    project,
    assetsPath,
    restored: assetsPath ? await isUntrackedFile(wtPath, assetsPath) : false,
  };
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
  if (!expanded || expanded.includes("$(")) return null;
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
  if (UNFOLLOWED_IMPORTS.test(text)) return null;

  const settings = scanPropertyGroups(text, file);
  if (!settings) return null;
  for (const [element] of text.matchAll(IMPORT_ELEMENT)) {
    const project = xmlAttribute(element, "Project");
    const conditional = xmlAttribute(element, "Condition") !== null;
    if (xmlAttribute(element, "Sdk") !== null || !project) return null;
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

/**
 * The layout properties set in a file, or null when it mentions one in a way this scan does not
 * read (a `Choose`, a `Target`, CDATA, a nested or self-closed element).
 */
function scanPropertyGroups(source: string, file: string): PropSetting[] | null {
  const text = stripXmlComments(source);
  const mentions = text.match(LAYOUT_PROP_MENTION)?.length ?? 0;
  if (mentions === 0) return [];
  if (UNSCANNED_CONSTRUCT.test(text)) return null;
  const settings: PropSetting[] = [];
  for (const [, groupAttributes, body] of text
    .replace(SELF_CLOSED_GROUP, "")
    .matchAll(PROPERTY_GROUP)) {
    const groupConditional = /\bCondition\s*=/i.test(groupAttributes!);
    for (const [, name, attributes, value] of body!.matchAll(PROPERTY_ELEMENT)) {
      const lowered = name!.toLowerCase();
      if (!isLayoutProp(lowered)) continue;
      settings.push({
        name: lowered,
        value: value!.trim(),
        conditional: groupConditional || /\bCondition\s*=/i.test(attributes!),
        file,
      });
    }
  }
  return settings.length === mentions ? settings : null;
}

/** Until nothing changes, since removing one comment can complete the opening of another. */
function stripXmlComments(text: string): string {
  let stripped = text;
  for (;;) {
    const next = stripped.replace(/<!--[\s\S]*?-->/g, "");
    if (next === stripped) return stripped;
    stripped = next;
  }
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
    const layouts = await Promise.all(
      projects.map((project) =>
        restoreLayout(project).catch((): RestoreLayout => ({
          assetsPath: null,
          inputs: [project],
        })),
      ),
    );
    if (!isCurrent()) return;
    // Armed before reading, so a change made while reading schedules another read.
    armRestoreWatches(wtPath, entry, layouts);
    const states = await Promise.all(
      projects.map((project) => csharpRestoreState(wtPath, project)),
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

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}
