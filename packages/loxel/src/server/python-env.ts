import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, constants, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { PythonEnv, PythonEnvSource } from "@/api/python-env-model";
import { isDirectory } from "@/fs-utils";

import { readOnlyGitEnv } from "./git-commands";
import { logger } from "./logger";
import { getPythonOverride } from "./python-override-store";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("server");

/** Virtual environment directories looked for at the worktree root (uv, uv workspaces, PDM, `python -m venv`). */
const VENV_DIR_NAMES = [".venv", "venv", "env"] as const;
/** Pixi's environments, and its default one, relative to a project directory. */
const PIXI_ENVS_DIR = ".pixi/envs";
const PIXI_ENV_DIR = `${PIXI_ENVS_DIR}/default`;
/** Files marking a Python project directory, where {@link listPythonEnvs} looks for environments. */
const PROJECT_MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "pixi.toml",
];
/** How deep below the worktree root, and how many, project directories are searched. */
const MAX_PROJECT_DEPTH = 3;
const MAX_PROJECT_DIRS = 50;
const POETRY_LOCK = "poetry.lock";
const POETRY_TIMEOUT_MS = 10_000;
/** Quiet period after the last filesystem event before re-resolving (installers write in bursts). */
const WATCH_DEBOUNCE_MS = 1000;

const IS_WINDOWS = process.platform === "win32";
/** `runGit` exit code when git could not be started (missing binary, unusable directory). */
const GIT_SPAWN_FAILED = -1;

/** A live {@link watchPythonEnv} watch. */
export interface PythonEnvWatch {
  close(): void;
  /** True when a change was seen whose debounced `onChange` has not fired yet. */
  readonly hasPendingChange: boolean;
  /** Report a change seen elsewhere, through the same debounce. */
  nudge(): void;
}

export interface ResolvePythonEnvOptions {
  /**
   * Interpreter chosen explicitly for this worktree; wins whenever it is usable. Defaults to the
   * one the user chose for the worktree (see `python-override-store.ts`); null skips any override.
   */
  overridePath?: string | null;
  /** Environment for `VIRTUAL_ENV` and PATH lookups. Defaults to the login-shell spawn environment. */
  env?: Record<string, string | undefined>;
}

/**
 * Find the Python interpreter for a worktree, in order: the chosen override, `VIRTUAL_ENV` when
 * it lies inside the worktree, a `.venv` / `venv` / `env` virtual environment at the worktree
 * root, Pixi's default environment, Poetry's environment (only with a `poetry.lock` and `poetry`
 * on PATH), then `python3` / `python` on the login-shell PATH. Any candidate counts only when its
 * interpreter exists, is executable, and is not a file the repository tracks. Never throws;
 * returns null when nothing is found.
 */
export async function resolvePythonEnv(
  worktreePath: string,
  options: ResolvePythonEnvOptions = {},
): Promise<PythonEnv | null> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  try {
    const overridePath =
      options.overridePath === undefined ? getPythonOverride(wtPath) : options.overridePath;
    if (overridePath) {
      const found = await interpreterAt(wtPath, overridePath, "override");
      if (found) return found;
    }

    const virtualEnv = env.VIRTUAL_ENV ? path.resolve(env.VIRTUAL_ENV) : null;
    if (virtualEnv && isInside(virtualEnv, wtPath)) {
      const found = await envAt(wtPath, virtualEnv, "virtual-env");
      if (found) return found;
    }

    for (const name of VENV_DIR_NAMES) {
      const found = await venvAt(wtPath, path.join(wtPath, name));
      if (found) return found;
    }

    const pixi = await envAt(wtPath, path.join(wtPath, PIXI_ENV_DIR), "pixi");
    if (pixi) return pixi;

    const poetry = await poetryEnv(wtPath, env);
    if (poetry) return poetry;

    return await systemPython(wtPath, env);
  } catch (err) {
    log.warn("Python environment resolution failed", { wtPath, error: err });
    return null;
  }
}

/** The interpreters the user can choose from for a worktree; see {@link listPythonEnvs}. */
export interface PythonEnvChoices {
  candidates: PythonEnv[];
  /** What automatic detection picks; also the first candidate. */
  automatic: PythonEnv | null;
}

/**
 * Every interpreter the user can choose for a worktree, without duplicates: the one automatic
 * detection picks first, then `.venv` / `venv` / `env` and Pixi environments at the root and in
 * Python project directories below it (those holding a `pyproject.toml`, `requirements.txt`, ...),
 * Poetry's environment, `python3` on the login-shell PATH, and last the chosen override when it
 * is none of those. Never throws.
 */
export async function listPythonEnvs(
  worktreePath: string,
  options: Pick<ResolvePythonEnvOptions, "env"> = {},
): Promise<PythonEnvChoices> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  try {
    const overridePath = getPythonOverride(wtPath);
    const projectDirs = [wtPath, ...(await pythonProjectDirs(wtPath))];
    const [automatic, ...found] = await Promise.all([
      resolvePythonEnv(wtPath, { overridePath: null, env }),
      ...projectDirs.flatMap((dir) => [
        ...VENV_DIR_NAMES.map((name) => venvAt(wtPath, path.join(dir, name))),
        ...pixiEnvDirs(dir).map((envPath) => envAt(wtPath, envPath, "pixi")),
      ]),
      poetryEnv(wtPath, env),
      systemPython(wtPath, env),
      overridePath ? interpreterAt(wtPath, overridePath, "override") : null,
    ]);
    const byPath = new Map<string, PythonEnv>();
    for (const candidate of [automatic, ...found]) {
      if (candidate && !byPath.has(candidate.pythonPath))
        byPath.set(candidate.pythonPath, candidate);
    }
    return { candidates: [...byPath.values()], automatic: automatic ?? null };
  } catch (err) {
    log.warn("Listing Python environments failed", { wtPath, error: err });
    return { candidates: [], automatic: null };
  }
}

/**
 * Check an interpreter the user entered for a worktree and return it as an absolute interpreter
 * path. Accepts `~/` paths and environment directories (their `bin/python`). Throws an error
 * meant for the user when the path is not an executable file or the repository tracks it.
 */
export async function normalizePythonOverride(
  worktreePath: string,
  input: string,
): Promise<string> {
  const wtPath = path.resolve(worktreePath);
  const trimmed = input.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) throw new Error("Enter an absolute path to a Python interpreter");
  const target = path.resolve(expanded);
  const candidates = isDirectory(target)
    ? interpreterRelativePaths().map((relative) => path.join(target, relative))
    : [target];
  for (const pythonPath of candidates) {
    if (!(await isExecutable(pythonPath))) continue;
    if (await isShippedByRepo(wtPath, pythonPath)) {
      throw new Error("Loxel does not run Python interpreters that the repository tracks in git");
    }
    return pythonPath;
  }
  throw new Error(`No executable Python interpreter at ${target}`);
}

/**
 * Call `onChange` (debounced) when the worktree's Python environment may have changed: a
 * candidate environment appearing, disappearing or being populated, `poetry.lock` changing, or
 * `current` being recreated or receiving packages. Watches are non-recursive and fixed to the
 * layout seen now, so callers re-resolve and re-watch on every change; to not lose a change made
 * while re-resolving, keep the old watch until the new one is armed and check its
 * `hasPendingChange` before closing it.
 */
export function watchPythonEnv(
  worktreePath: string,
  current: PythonEnv | null,
  onChange: () => void,
): PythonEnvWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  const watchers: FSWatcher[] = [];
  for (const [dir, names] of watchTargets(path.resolve(worktreePath), current)) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        // A null filename means the platform could not say what changed; treat it as relevant.
        if (names === null || filename === null || names.has(filename)) schedule();
      });
      watcher.on("error", (err) =>
        log.debug("Python environment watch failed", { dir, error: err }),
      );
      watchers.push(watcher);
    } catch (err) {
      log.debug("Could not watch for Python environment changes", { dir, error: err });
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers) watcher.close();
    },
    get hasPendingChange() {
      return timer !== null;
    },
    nudge: schedule,
  };
}

/**
 * Directories to watch, each with the entry names that matter there (null = every entry). For a
 * candidate environment that does not exist yet, its deepest existing ancestor is watched for the
 * next path segment; an existing one is watched for its interpreter directory and marker files.
 */
function watchTargets(wtPath: string, current: PythonEnv | null): Map<string, Set<string> | null> {
  const targets = new Map<string, Set<string> | null>();
  const add = (dir: string, name: string | null) => {
    const names = targets.get(dir);
    if (names === null) return;
    if (name === null) targets.set(dir, null);
    else if (names) names.add(name);
    else targets.set(dir, new Set([name]));
  };
  // The interpreter can land in a `bin` that already exists (conda/pixi create it early), which
  // the filtered watch on the environment directory never reports.
  const addInterpreterDirs = (envPath: string) => {
    for (const name of interpreterDirNames()) {
      const dir = path.join(envPath, name);
      if (isDirectory(dir)) add(dir, null);
    }
  };

  for (const candidate of [...VENV_DIR_NAMES, PIXI_ENV_DIR]) {
    let dir = wtPath;
    let missing: string | null = null;
    for (const segment of candidate.split("/")) {
      if (!isDirectory(path.join(dir, segment))) {
        missing = segment;
        break;
      }
      dir = path.join(dir, segment);
    }
    if (missing) {
      add(dir, missing);
      continue;
    }
    for (const name of [...interpreterDirNames(), "pyvenv.cfg", "conda-meta"]) add(dir, name);
    addInterpreterDirs(dir);
  }
  add(wtPath, POETRY_LOCK);

  if (current?.envPath) {
    // Also covers environments outside the worktree (Poetry's cache, VIRTUAL_ENV, the override).
    add(path.dirname(current.envPath), path.basename(current.envPath));
    for (const name of [...interpreterDirNames(), "pyvenv.cfg"]) add(current.envPath, name);
    addInterpreterDirs(current.envPath);
    for (const dir of sitePackagesDirs(current.envPath)) add(dir, null);
  } else if (current) {
    // An interpreter outside any environment (a chosen `/opt/homebrew/bin/python3.12`): notice it
    // being removed, so detection takes over.
    add(path.dirname(current.pythonPath), path.basename(current.pythonPath));
  }
  return targets;
}

async function envAt(
  wtPath: string,
  envPath: string,
  source: PythonEnvSource,
): Promise<PythonEnv | null> {
  for (const relative of interpreterRelativePaths()) {
    const pythonPath = path.join(envPath, relative);
    if (!(await isExecutable(pythonPath))) continue;
    if (await isShippedByRepo(wtPath, pythonPath)) {
      log.warn("Ignoring a Python interpreter tracked by git", { wtPath, pythonPath });
      return null;
    }
    return { source, pythonPath, envPath };
  }
  return null;
}

/** A virtual environment (a directory with `pyvenv.cfg`) at `dir`. */
async function venvAt(wtPath: string, dir: string): Promise<PythonEnv | null> {
  if (!(await Bun.file(path.join(dir, "pyvenv.cfg")).exists())) return null;
  return envAt(wtPath, dir, "venv");
}

/** An interpreter given by path (the override), held to the same rules as detected ones. */
async function interpreterAt(
  wtPath: string,
  pythonPath: string,
  source: PythonEnvSource,
): Promise<PythonEnv | null> {
  // A relative path would be checked against the server's directory but tracked-checked in the
  // worktree; overrides are stored absolute, so anything else is not one Loxel wrote.
  if (!path.isAbsolute(pythonPath) || !(await isExecutable(pythonPath))) return null;
  if (await isShippedByRepo(wtPath, pythonPath)) {
    log.warn("Ignoring a Python interpreter tracked by git", { wtPath, pythonPath });
    return null;
  }
  return { source, pythonPath, envPath: await envPrefixOf(pythonPath) };
}

async function systemPython(
  wtPath: string,
  env: Record<string, string | undefined>,
): Promise<PythonEnv | null> {
  // PATH can include a directory of the worktree itself (direnv's `PATH_add bin`).
  const PATH = env.PATH ?? "";
  for (const name of ["python3", "python"]) {
    const system = Bun.which(name, { PATH });
    if (system && !(await isShippedByRepo(wtPath, system))) {
      return { source: "system", pythonPath: system, envPath: null };
    }
  }
  return null;
}

/**
 * Directories below the worktree root (not the root itself) holding a Python project marker,
 * from git's view of the tree, so ignored directories such as `node_modules` are skipped.
 */
async function pythonProjectDirs(wtPath: string): Promise<string[]> {
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
        ...PROJECT_MARKERS.map((marker) => `:(glob)**/${marker}`),
      ],
      { env: readOnlyGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return [];
    const dirs = new Set<string>();
    for (const file of stdout.split("\0")) {
      const dir = path.posix.dirname(file);
      if (!file || dir === "." || dir.split("/").length > MAX_PROJECT_DEPTH) continue;
      dirs.add(dir);
    }
    return [...dirs]
      .toSorted()
      .slice(0, MAX_PROJECT_DIRS)
      .map((dir) => path.join(wtPath, dir));
  } catch (err) {
    log.debug("Listing Python project directories failed", { wtPath, error: err });
    return [];
  }
}

function pixiEnvDirs(projectDir: string): string[] {
  const envsDir = path.join(projectDir, PIXI_ENVS_DIR);
  try {
    return readdirSync(envsDir)
      .map((name) => path.join(envsDir, name))
      .filter(isDirectory);
  } catch {
    return [];
  }
}

/**
 * Whether the interpreter (or what its symlinks resolve to) is a file git tracks in the worktree,
 * including in a submodule or nested repository inside it. Real environments are never committed,
 * and Loxel and Pyright execute the interpreter, so a committed `.venv/bin/python` would otherwise
 * run repository code as soon as a Python file is opened.
 */
async function isShippedByRepo(wtPath: string, pythonPath: string): Promise<boolean> {
  const candidates = [pythonPath, await realpath(pythonPath)];
  const tracked = await Promise.all(candidates.map((file) => isTrackedByGit(wtPath, file)));
  return tracked.some(Boolean);
}

/**
 * Asks the innermost repository containing `filePath`, since a submodule or nested repository
 * tracks its own files and the worktree's index does not list them. Inside a git worktree, any
 * answer other than a clear "untracked" counts as tracked (fail closed).
 */
async function isTrackedByGit(wtPath: string, filePath: string): Promise<boolean> {
  const realWtPath = await realpath(wtPath);
  if (!isInside(filePath, wtPath) && !isInside(filePath, realWtPath)) return false;
  const worktreeRepo = await runGit(wtPath, ["rev-parse", "--show-toplevel"]);
  if (worktreeRepo.exitCode === GIT_SPAWN_FAILED) return true;
  // Not a repository at all, so nothing in it can be committed.
  if (worktreeRepo.exitCode !== 0) return false;

  const innermost = await runGit(path.dirname(filePath), ["rev-parse", "--show-toplevel"]);
  if (innermost.exitCode !== 0) return true;
  const listed = await runGit(innermost.stdout.trim(), [
    "ls-files",
    "--error-unmatch",
    "--",
    filePath,
  ]);
  // `--error-unmatch` exits 1 for an untracked path; anything else is tracked or an error.
  return listed.exitCode !== 1;
}

async function runGit(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      env: readOnlyGitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  } catch {
    return { exitCode: GIT_SPAWN_FAILED, stdout: "" };
  }
}

/** The environment directory an interpreter belongs to, if it is a venv or conda environment. */
async function envPrefixOf(pythonPath: string): Promise<string | null> {
  const binDir = path.dirname(pythonPath);
  for (const prefix of [path.dirname(binDir), binDir]) {
    if (await Bun.file(path.join(prefix, "pyvenv.cfg")).exists()) return prefix;
    if (isDirectory(path.join(prefix, "conda-meta"))) return prefix;
  }
  return null;
}

async function poetryEnv(
  wtPath: string,
  env: Record<string, string | undefined>,
): Promise<PythonEnv | null> {
  if (!(await Bun.file(path.join(wtPath, POETRY_LOCK)).exists())) return null;
  const poetry = Bun.which("poetry", { PATH: env.PATH ?? "" });
  if (!poetry) return null;

  // Poetry reports an activated environment as the project's own, so hide the one Loxel was
  // launched with.
  const { VIRTUAL_ENV: _venv, CONDA_PREFIX: _conda, ...poetryEnvVars } = env;
  try {
    const proc = Bun.spawn([poetry, "env", "info", "--path"], {
      cwd: wtPath,
      env: poetryEnvVars,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: POETRY_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // Exits non-zero when the project has no environment yet.
    const envPath = stdout.trim();
    if (exitCode !== 0 || !envPath) return null;
    return await envAt(wtPath, envPath, "poetry");
  } catch (err) {
    log.debug("poetry env info failed", { wtPath, error: err });
    return null;
  }
}

function interpreterRelativePaths(): string[] {
  return IS_WINDOWS ? ["Scripts/python.exe", "python.exe"] : ["bin/python", "bin/python3"];
}

function interpreterDirNames(): string[] {
  return IS_WINDOWS ? ["Scripts", "python.exe"] : ["bin"];
}

function sitePackagesDirs(envPath: string): string[] {
  if (IS_WINDOWS) return [path.join(envPath, "Lib", "site-packages")];
  const libDir = path.join(envPath, "lib");
  try {
    return readdirSync(libDir)
      .filter((name) => name.startsWith("python"))
      .map((name) => path.join(libDir, name, "site-packages"))
      .filter(isDirectory);
  } catch {
    return [];
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    // Follows symlinks, so a venv whose base interpreter was removed does not count.
    await access(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}
