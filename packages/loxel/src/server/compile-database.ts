import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ClangdConfigEffect,
  CompileDatabaseFileResponse,
  CompileDatabaseStatus,
} from "@/api/c-cpp-compile-database-model";

import { getCompileDatabaseChoice } from "./compile-database-store";
import { logger } from "./logger";
import { isInside } from "./shipped-by-repo";

const log = logger.child("clangd-lsp");

const COMPILE_COMMANDS = "compile_commands.json";
const COMPILE_FLAGS = "compile_flags.txt";
/** What clangd tries in a folder, in its order. It has no `build/compile_flags.txt`. */
const DATABASE_FILES = [COMPILE_COMMANDS, `build/${COMPILE_COMMANDS}`, COMPILE_FLAGS];
const CLANGD_CONFIG = ".clangd";
/** Project config files larger than this are not read. */
const MAX_CONFIG_BYTES = 1024 * 1024;
/** What one look at a worktree reads of `.clangd` files; past it, the worktree counts as not searched. */
const MAX_CONFIG_BYTES_PER_WALK = 16 * 1024 * 1024;
/** Enough of each end of a compile database to tell a JSON array, without reading it all. */
const SHAPE_SAMPLE_BYTES = 4096;
/** Past this the worktree has not been searched whole. Takes well under a second. */
const MAX_WALKED_DIRS = 5000;
/** Never a project's sources. */
const UNWALKED_DIR = /^(\.git|\.cache|node_modules)$/;
/** At the root these are looked at as candidates, and hold no sources of their own. */
const BUILD_DIR_AT_ROOT = /^(build|out|build-.*|cmake-build-.*)$/;
const CANDIDATE_AT_ROOT = /^(cmake-build-|build-)/;
/** Folders under the root whose subfolders may each be a build: `build/*`, `out/*`, `out/build/*`. */
const CANDIDATE_PARENTS = ["build", "out", "out/build"];
/** Most folders looked at as candidates: a repository decides how many `out/*` has. */
const MAX_CANDIDATE_FOLDERS = 256;
/** What a build system's configure step leaves in its output folder, whatever it is called. */
const GENERATED_FOLDER_MARKERS = ["CMakeCache.txt", "build.ninja", "meson-info"];

/** Whether a compile database is well-formed at both ends. clangd passes over one that is not. */
async function looksLikeCompileCommands(file: string, size: number): Promise<boolean> {
  try {
    const handle = Bun.file(file);
    const head = await handle.slice(0, SHAPE_SAMPLE_BYTES).text();
    const tail = await handle.slice(Math.max(0, size - SHAPE_SAMPLE_BYTES), size).text();
    return head.trimStart().startsWith("[") && tail.trimEnd().endsWith("]");
  } catch {
    return false;
  }
}

/** Whether clangd would load this file as a database. Follows links, as clangd does. */
async function isDatabaseFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    return (
      path.basename(file) === COMPILE_FLAGS || (await looksLikeCompileCommands(file, info.size))
    );
  } catch {
    return false;
  }
}

/** The database clangd takes from one folder, or null. */
async function databaseIn(dir: string): Promise<string | null> {
  for (const relative of DATABASE_FILES) {
    const file = path.join(dir, relative);
    if (await isDatabaseFile(file)) return file;
  }
  return null;
}

/** The parts of one `.clangd` file that matter here. */
interface ClangdConfigFile {
  /** `CompileFlags.CompilationDatabase`, from a document that applies to every file. */
  database: string | null;
  /** The folders any document names, including one that applies only to some files. */
  namedFolders: string[];
  /**
   * Whether any document sets it to other than clangd's default. Also true of a file that could not
   * be read whole if it may: clangd applies the documents before one that does not parse.
   */
  anyDatabase: boolean;
  addsFlags: boolean;
}

const DATABASE_KEY = "CompilationDatabase";
const SPECIAL_DATABASE_VALUES: ReadonlySet<string> = new Set(["None", "Ancestors"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseClangdConfig(text: string): ClangdConfigFile {
  const result: ClangdConfigFile = {
    database: null,
    namedFolders: [],
    anyDatabase: false,
    addsFlags: false,
  };
  // Most have neither, and parsing is the costly part.
  if (!text.includes(DATABASE_KEY) && !text.includes("Add")) return result;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    log.debug("Could not parse a .clangd file", { error: err });
    result.anyDatabase = text.includes(DATABASE_KEY);
    return result;
  }
  // A file of several documents comes as an array of them.
  const documents = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  for (const document of documents) {
    const fragment = asRecord(document);
    const flags = asRecord(fragment?.CompileFlags);
    if (!fragment || !flags) continue;
    const unconditional = fragment.If === undefined;
    const database = flags[DATABASE_KEY];
    if (typeof database === "string") {
      // `Ancestors` asks for what clangd does anyway.
      if (database !== "Ancestors") result.anyDatabase = true;
      if (!SPECIAL_DATABASE_VALUES.has(database)) result.namedFolders.push(database);
      // A condition's outcome isn't worked out here: it takes a repository's regular expressions.
      if (unconditional) result.database = database;
    }
    if (unconditional && flags.Add !== undefined) result.addsFlags = true;
  }
  return result;
}

/** Null when there is no such file. Over the size limit it is not read, and may name a database. */
async function readClangdConfig(file: string): Promise<ClangdConfigFile | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > MAX_CONFIG_BYTES) {
    return { database: null, namedFolders: [], anyDatabase: true, addsFlags: false };
  }
  try {
    return parseClangdConfig(await Bun.file(file).text());
  } catch (err) {
    log.debug("Could not read a .clangd file", { file, error: err });
    return null;
  }
}

/** Each folder from `dir` up to the filesystem root. */
function* ancestors(dir: string): Generator<string> {
  let current = dir;
  while (true) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

interface ClangdFinding {
  database: { path: string; source: "search" | "clangd-config" } | null;
  clangdConfig: ClangdConfigEffect | null;
}

/**
 * What clangd finds by itself for a file in `dir`, mirroring its rules, as it reports nothing about
 * this to a client: the nearest `.clangd` naming a database decides, and otherwise the nearest
 * folder with one, however the file itself is listed there.
 */
async function clangdFindingFor(dir: string): Promise<ClangdFinding> {
  let flagsFrom: string | null = null;
  let configured: { file: string; value: string } | null = null;
  for (const folder of ancestors(dir)) {
    const file = path.join(folder, CLANGD_CONFIG);
    // oxlint-disable-next-line no-await-in-loop -- nearest first, and most folders have none
    const config = await readClangdConfig(file);
    if (config?.addsFlags) flagsFrom ??= file;
    if (config?.database && !configured) configured = { file, value: config.database };
  }

  const noDatabase = (effect: ClangdConfigEffect["effect"], file: string): ClangdFinding => ({
    database: null,
    clangdConfig: { path: file, effect },
  });

  if (configured && configured.value !== "Ancestors") {
    if (configured.value === "None") return noDatabase("none", configured.file);
    const named = await databaseIn(path.resolve(path.dirname(configured.file), configured.value));
    if (!named) return noDatabase("missing", configured.file);
    return { database: { path: named, source: "clangd-config" }, clangdConfig: null };
  }
  for (const folder of ancestors(dir)) {
    // oxlint-disable-next-line no-await-in-loop -- nearest first
    const found = await databaseIn(folder);
    if (found) return { database: { path: found, source: "search" }, clangdConfig: null };
  }
  return flagsFrom ? noDatabase("flags", flagsFrom) : { database: null, clangdConfig: null };
}

async function readDirents(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Whether a folder is build output by what is in it, under whatever name. */
function isGeneratedFolder(names: ReadonlySet<string>): boolean {
  return GENERATED_FOLDER_MARKERS.some((marker) => names.has(marker));
}

/** Whether each part of a path below `root` is a real directory, and none of them a link. */
async function isRealPathBelow(root: string, relative: string): Promise<boolean> {
  let dir = root;
  for (const part of relative.split("/")) {
    dir = path.join(dir, part);
    // oxlint-disable-next-line no-await-in-loop -- a part may only be trusted once the last one is
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) return false;
  }
  return true;
}

/**
 * Folders under the root holding a database clangd's search misses: by the names build tools give
 * them, or by what a configure step leaves in them. With `fs`, since they are git-ignored. Links
 * aren't followed, neither the folder nor the file, so nothing here leads out of the worktree.
 */
async function findCandidates(wtPath: string): Promise<string[]> {
  const rootEntries = await readDirents(wtPath);
  const folders = rootEntries
    .filter((entry) => entry.isDirectory() && CANDIDATE_AT_ROOT.test(entry.name))
    .map((entry) => path.join(wtPath, entry.name));
  for (const parent of CANDIDATE_PARENTS) {
    // oxlint-disable-next-line no-await-in-loop -- at most three short listings
    if (!(await isRealPathBelow(wtPath, parent))) continue;
    const parentDir = path.join(wtPath, parent);
    // oxlint-disable-next-line no-await-in-loop -- as above
    for (const entry of await readDirents(parentDir)) {
      if (entry.isDirectory()) folders.push(path.join(parentDir, entry.name));
    }
  }
  const others = rootEntries.filter(
    (entry) =>
      entry.isDirectory() && !UNWALKED_DIR.test(entry.name) && !BUILD_DIR_AT_ROOT.test(entry.name),
  );
  const generated = await Promise.all(
    others.slice(0, MAX_CANDIDATE_FOLDERS).map(async (entry) => {
      const folder = path.join(wtPath, entry.name);
      const names = new Set((await readDirents(folder)).map((inner) => inner.name));
      return isGeneratedFolder(names) ? folder : null;
    }),
  );
  folders.push(...generated.filter((folder) => folder !== null));
  const held = await Promise.all(
    [...new Set(folders)].slice(0, MAX_CANDIDATE_FOLDERS).map(async (folder) => {
      const file = path.join(folder, COMPILE_COMMANDS);
      const info = await lstat(file).catch(() => null);
      return info?.isFile() && (await looksLikeCompileCommands(file, info.size)) ? folder : null;
    }),
  );
  return held.filter((folder) => folder !== null).toSorted();
}

interface ClangdsOwn {
  found: Set<string>;
  cut: boolean;
  /** A `.clangd` names a database folder outside the worktree, and clangd's index would go there. */
  namesOutside: boolean;
}

async function realPathOf(file: string): Promise<string> {
  return realpath(file).catch(() => file);
}

/** Note what one `.clangd` says. Returns false when the walk's budget for reading them has gone. */
async function addConfigFindings(
  file: string,
  own: ClangdsOwn,
  budget: { bytes: number },
  realRoot: string,
): Promise<boolean> {
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  budget.bytes -= Math.min(size, MAX_CONFIG_BYTES);
  if (budget.bytes < 0) return false;
  const config = await readClangdConfig(file);
  if (config?.anyDatabase) own.found.add(file);
  // Fails closed: one that could not be read whole may name anything.
  if (config?.anyDatabase && config.namedFolders.length === 0 && !config.database) {
    own.namesOutside ||= size > MAX_CONFIG_BYTES || (await unparsedNamesDatabase(file));
  }
  for (const named of config?.namedFolders ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- few, and most files have none
    const real = await realPathOf(path.resolve(path.dirname(file), named));
    if (!isInside(real, realRoot)) own.namesOutside = true;
  }
  return true;
}

/** Whether a `.clangd` that does not parse as a whole names a database, as `None` does not. */
async function unparsedNamesDatabase(file: string): Promise<boolean> {
  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  return new RegExp(`${DATABASE_KEY}\\s*:\\s*(?!None\\b|Ancestors\\b)\\S`).test(text);
}

/**
 * Where clangd finds a database by itself for some of the worktree's files: from the root, and in
 * each project below it. The whole tree, within limits, rather than to a depth: a project missed
 * here would have its own database overridden. Build output is left out, under whatever name, as
 * clangd finds a database in it only for files inside it.
 */
async function findClangdsOwn(wtPath: string): Promise<ClangdsOwn> {
  const own: ClangdsOwn = { found: new Set(), cut: false, namesOutside: false };
  const fromRoot = await clangdFindingFor(wtPath);
  if (fromRoot.database) own.found.add(fromRoot.database.path);
  // Off or pointing nowhere is the project's own decision about its database.
  if (fromRoot.clangdConfig && fromRoot.clangdConfig.effect !== "flags") {
    own.found.add(fromRoot.clangdConfig.path);
  }

  const realRoot = await realPathOf(wtPath);
  const budget = { bytes: MAX_CONFIG_BYTES_PER_WALK };
  const pending = [wtPath];
  let walked = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (walked >= MAX_WALKED_DIRS) return { ...own, cut: true };
    walked += 1;
    // oxlint-disable-next-line no-await-in-loop -- one folder at a time, to stay light on the disk
    const entries = await readDirents(dir);
    const names = new Set(entries.map((entry) => entry.name));
    if (isGeneratedFolder(names)) continue;
    for (const entry of entries) {
      const skipped =
        UNWALKED_DIR.test(entry.name) || (dir === wtPath && BUILD_DIR_AT_ROOT.test(entry.name));
      if (entry.isDirectory() && !skipped) pending.push(path.join(dir, entry.name));
    }
    if (names.has(COMPILE_COMMANDS) || names.has(COMPILE_FLAGS) || names.has("build")) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const database = await databaseIn(dir);
      if (database) own.found.add(database);
    }
    if (
      names.has(CLANGD_CONFIG) &&
      // oxlint-disable-next-line no-await-in-loop -- as above
      !(await addConfigFindings(path.join(dir, CLANGD_CONFIG), own, budget, realRoot))
    ) {
      return { ...own, cut: true };
    }
  }
  return own;
}

async function lookAtWorktree(wtPath: string): Promise<CompileDatabaseStatus> {
  const chosen = getCompileDatabaseChoice(wtPath);
  const [chosenDatabase, candidates, own] = await Promise.all([
    chosen ? databaseIn(chosen) : null,
    findCandidates(wtPath),
    findClangdsOwn(wtPath),
  ]);
  // A flag applies to every file, so it goes only where clangd's own search has nothing to lose.
  const automatic =
    candidates.length === 1 && own.found.size === 0 && !own.cut ? (candidates[0] ?? null) : null;
  return {
    chosen,
    chosenUsable: chosenDatabase !== null,
    automatic,
    candidates,
    foundByClangd: [...own.found].toSorted(),
    searchCut: own.cut,
    namesOutsideDatabase: own.namesOutside,
  };
}

const runningLooks = new Map<string, Promise<CompileDatabaseStatus>>();
const queuedLooks = new Map<string, Promise<CompileDatabaseStatus>>();

function startLook(wtPath: string): Promise<CompileDatabaseStatus> {
  const look = lookAtWorktree(wtPath).finally(() => {
    if (runningLooks.get(wtPath) === look) runningLooks.delete(wtPath);
  });
  runningLooks.set(wtPath, look);
  return look;
}

/**
 * A worktree's databases, read afresh: this is what each clangd start and status request goes by.
 * Callers during a look share the one after it, which sees whatever made them ask, so that requests
 * arriving together cost at most two walks.
 */
export function resolveCompileDatabases(worktreePath: string): Promise<CompileDatabaseStatus> {
  const wtPath = path.resolve(worktreePath);
  const running = runningLooks.get(wtPath);
  if (!running) return startLook(wtPath);
  const queued = queuedLooks.get(wtPath);
  if (queued) return queued;
  const next = running
    .catch(() => null)
    .then(() => {
      queuedLooks.delete(wtPath);
      return startLook(wtPath);
    });
  queuedLooks.set(wtPath, next);
  return next;
}

/** The folder to pass as `--compile-commands-dir`, or null to leave the search to clangd. */
export function compileCommandsDir(status: CompileDatabaseStatus): string | null {
  return status.chosenUsable ? status.chosen : status.automatic;
}

const BUILD_SYSTEMS = [
  ["CMakeLists.txt", "cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON"],
  ["meson.build", "meson setup build"],
  ["Makefile", "bear -- make"],
  ["makefile", "bear -- make"],
  ["GNUmakefile", "bear -- make"],
] as const;

const GENERIC_HINT = `Have your build system write a ${COMPILE_COMMANDS}, or add a ${COMPILE_FLAGS} with one flag per line`;

/** What to run for a file with no database, from the outermost build file up to the worktree. */
async function databaseHint(wtPath: string, filePath: string): Promise<string> {
  let hint: string | null = null;
  let dir = path.dirname(filePath);
  while (isInside(dir, wtPath)) {
    for (const [name, command] of BUILD_SYSTEMS) {
      // oxlint-disable-next-line no-await-in-loop -- only a few folders, each with few names
      if (await Bun.file(path.join(dir, name)).exists()) {
        const relative = path.relative(wtPath, dir);
        hint = `Run ${command} in a terminal${relative ? `, in ${relative}` : ""}`;
        break;
      }
    }
    if (dir === wtPath) break;
    dir = path.dirname(dir);
  }
  return hint ?? GENERIC_HINT;
}

/** The database clangd uses for a file, by the flag if Loxel passes one and its own rules if not. */
export async function resolveFileCompileDatabase(
  worktreePath: string,
  filePath: string,
): Promise<CompileDatabaseFileResponse> {
  const wtPath = path.resolve(worktreePath);
  const status = await resolveCompileDatabases(wtPath);
  const dir = compileCommandsDir(status);
  if (dir) {
    const database = await databaseIn(dir);
    if (database) {
      return {
        database: { path: database, source: status.chosenUsable ? "chosen" : "automatic" },
        clangdConfig: null,
        hint: null,
      };
    }
  }
  const finding = await clangdFindingFor(path.dirname(filePath));
  return { ...finding, hint: finding.database ? null : await databaseHint(wtPath, filePath) };
}

/**
 * The folder for a path the user entered, which may be outside the worktree: a folder holding a
 * database, or a database file. Throws, with what to tell them, when it holds none.
 */
export async function normalizeCompileDatabaseChoice(
  worktreePath: string,
  input: string,
): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter the path of a folder with a compile database");
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(1)) : trimmed;
  const target = path.resolve(worktreePath, expanded);
  const isFile = (await stat(target).catch(() => null))?.isFile() ?? false;
  const dir = isFile ? path.dirname(target) : target;
  const direct = await Promise.all(
    [COMPILE_COMMANDS, COMPILE_FLAGS].map((name) => isDatabaseFile(path.join(dir, name))),
  );
  if (!direct.includes(true)) {
    throw new Error(`No usable ${COMPILE_COMMANDS} or ${COMPILE_FLAGS} in ${dir}`);
  }
  return dir;
}

/** What a {@link subscribeCompileDatabases} listener hears after each resolution. */
export interface CompileDatabaseUpdate {
  status: CompileDatabaseStatus;
  /** Anything the status item shows differs from the previous resolution's. */
  changed: boolean;
}

interface WatchedWorktree {
  listeners: Set<(update: CompileDatabaseUpdate) => void>;
  settled: string | null;
  /** The latest resolution's number: an older one finishing later has nothing to say. */
  generation: number;
}

const watched = new Map<string, WatchedWorktree>();

/** Hear about each resolution of a worktree's databases. Returns the unsubscribe function. */
export function subscribeCompileDatabases(
  worktreePath: string,
  listener: (update: CompileDatabaseUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  const entry = watched.get(wtPath) ?? { listeners: new Set(), settled: null, generation: 0 };
  watched.set(wtPath, entry);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && watched.get(wtPath) === entry) watched.delete(wtPath);
  };
}

/**
 * Resolve a subscribed worktree's databases again and tell its listeners. With `filesChanged`, a
 * database or `.clangd` changed on disk, which can change a single file's answer and not the
 * worktree's, so it counts as a change either way.
 */
export function refreshCompileDatabases(worktreePath: string, filesChanged = false): void {
  const wtPath = path.resolve(worktreePath);
  const entry = watched.get(wtPath);
  if (!entry) return;
  entry.generation += 1;
  const { generation } = entry;
  void resolveCompileDatabases(wtPath)
    .then((status) => {
      if (entry.generation !== generation) return;
      const serialized = JSON.stringify(status);
      const changed = filesChanged || serialized !== entry.settled;
      entry.settled = serialized;
      for (const listener of [...entry.listeners]) listener({ status, changed });
    })
    .catch((err: unknown) => {
      log.warn("Could not look for compile databases", { wtPath, error: err });
    });
}
