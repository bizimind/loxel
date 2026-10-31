import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { PythonEnv, PythonEnvSource } from "@/api/python-env-model";
import { isDirectory } from "@/fs-utils";

import { logger } from "./logger";
import { getPythonOverride } from "./python-override-store";
import { buildSpawnEnv } from "./shell-env";
import { isEnvShippedByRepo, isInside, isShippedByRepo, runGit } from "./shipped-by-repo";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("server");

/** Virtual environment directory names (uv, uv workspaces, PDM, `python -m venv`). */
export const VENV_DIR_NAMES = [".venv", "venv", "env"] as const;
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
/** Activated environments honored when they lie inside the worktree, in order. */
const ACTIVATED_ENV_VARS = [
  ["VIRTUAL_ENV", "virtual-env"],
  ["CONDA_PREFIX", "conda"],
] as const;
/** Tools that keep a project's environment outside it, asked only when their lock file exists. */
const POETRY = {
  source: "poetry",
  command: "poetry",
  lockFile: "poetry.lock",
  args: ["env", "info", "--path"],
} as const;
const PIPENV = {
  source: "pipenv",
  command: "pipenv",
  lockFile: "Pipfile.lock",
  args: ["--venv"],
} as const;
const ENV_TOOLS = [POETRY, PIPENV] as const;
type EnvTool = (typeof ENV_TOOLS)[number];
const ENV_TOOL_TIMEOUT_MS = 10_000;
/** Quiet period after the last filesystem event before re-resolving (installers write in bursts). */
const WATCH_DEBOUNCE_MS = 1000;

const IS_WINDOWS = process.platform === "win32";

type SpawnEnv = Record<string, string | undefined>;

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
  /** Environment for activated-environment and PATH lookups. Defaults to the login-shell spawn environment. */
  env?: SpawnEnv;
}

// ---------------------------------------------------------------------------
// The shared, memoized resolution per worktree

/** What a {@link subscribePythonEnv} listener hears after each finished resolution. */
export interface PythonEnvUpdate {
  env: PythonEnv | null;
  /** The worktree's first resolution since it was subscribed. */
  first: boolean;
  /** The interpreter, or the chosen override, differs from the previous resolution's. */
  changed: boolean;
}

interface WorktreePythonEnv {
  listeners: Set<(update: PythonEnvUpdate) => void>;
  /** The latest resolution, finished or not; null until something asks for the environment. */
  resolution: Promise<PythonEnv | null> | null;
  /** The last finished resolution and the override it was made with. */
  settled: { env: PythonEnv | null; overridePath: string | null } | null;
  /** True while {@link resolution} has not finished. */
  pending: boolean;
  /** The settled interpreter failed the trust rule since, so it is not handed out any more. */
  withdrawn: boolean;
  /** The override the latest resolution started with. */
  overridePath: string | null;
  watch: PythonEnvWatch | null;
}

const worktreeEnvs = new Map<string, WorktreePythonEnv>();

/**
 * Keep the worktree's resolution memoized and watched while subscribed, and call `listener` after
 * each resolution finishes: the first one, and each re-resolution that a watched change, a new
 * override or a newly tracked environment causes (also when the result is the same interpreter,
 * since packages may have been installed into it). Subscribing resolves nothing by itself; the
 * first {@link getPythonEnv} does. Returns the unsubscribe function; the memo and its watch go
 * with the last subscriber.
 */
export function subscribePythonEnv(
  worktreePath: string,
  listener: (update: PythonEnvUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  let entry = worktreeEnvs.get(wtPath);
  if (!entry) {
    entry = {
      listeners: new Set(),
      resolution: null,
      settled: null,
      pending: false,
      withdrawn: false,
      overridePath: null,
      watch: null,
    };
    worktreeEnvs.set(wtPath, entry);
  }
  const subscribed = entry;
  subscribed.listeners.add(listener);
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size > 0 || worktreeEnvs.get(wtPath) !== subscribed) return;
    subscribed.watch?.close();
    worktreeEnvs.delete(wtPath);
  };
}

/**
 * The worktree's interpreter (see {@link resolvePythonEnv}), shared by every caller: memoized while
 * the worktree is subscribed, re-resolved when its watch reports a change, its override changes,
 * or the chosen environment turned out to be tracked by git since. Waits for a re-resolution in
 * flight. Without a subscriber it resolves afresh, since nothing would keep a memo current.
 */
export async function getPythonEnv(worktreePath: string): Promise<PythonEnv | null> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (!entry) return resolvePythonEnv(wtPath);
  await revalidate(wtPath, entry);
  // Unsubscribed meanwhile: nothing would close a watch armed for it now.
  if (worktreeEnvs.get(wtPath) !== entry) return resolvePythonEnv(wtPath);
  return entry.resolution ?? startResolution(wtPath, entry);
}

/**
 * Like {@link getPythonEnv}, but answers with the last finished resolution while a re-resolution
 * is in flight, for callers that hear about the fresh one through {@link subscribePythonEnv}.
 */
export async function getPythonEnvNow(worktreePath: string): Promise<PythonEnv | null> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (!entry) return resolvePythonEnv(wtPath);
  await revalidate(wtPath, entry);
  if (worktreeEnvs.get(wtPath) !== entry) return resolvePythonEnv(wtPath);
  if (entry.pending && entry.settled && !entry.withdrawn) return entry.settled.env;
  return entry.resolution ?? startResolution(wtPath, entry);
}

/** Re-resolve a subscribed worktree's interpreter now, e.g. after its override changed. */
export function refreshPythonEnv(worktreePath: string): void {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (entry) startResolution(wtPath, entry);
}

/** Login-shell variables that resolution reads, directly or through the tools it runs. */
const RESOLUTION_ENV_VAR =
  /^(PATH|VIRTUAL_ENV|UV_PROJECT_ENVIRONMENT|(CONDA|PYENV|PIPENV|POETRY)_.*)$/;

/**
 * Re-resolve every subscribed worktree that has resolved, e.g. after the login-shell environment
 * was captured again. With `changedNames`, only when one of them can change a resolution: some
 * startup files export values that differ on every run (session keys, agent sockets).
 */
export function refreshAllPythonEnvs(changedNames?: Iterable<string>): void {
  if (changedNames && !Array.from(changedNames).some((name) => RESOLUTION_ENV_VAR.test(name))) {
    return;
  }
  for (const [wtPath, entry] of worktreeEnvs) {
    if (entry.resolution) startResolution(wtPath, entry);
  }
}

/**
 * Start a re-resolution when the latest one no longer holds: the override was changed behind the
 * store's change hook, or the repository now tracks the settled environment (the trust checks are
 * cached until a git index they read changes, so this is a few `stat` calls otherwise).
 */
async function revalidate(wtPath: string, entry: WorktreePythonEnv): Promise<void> {
  if (!entry.resolution || worktreeEnvs.get(wtPath) !== entry) return;
  if (getPythonOverride(wtPath) !== entry.overridePath) {
    startResolution(wtPath, entry);
    return;
  }
  const { settled } = entry;
  if (!settled?.env || entry.withdrawn) return;
  if (!(await isResolvedEnvShipped(wtPath, settled.env))) return;
  // Another caller may have noticed first, or the worktree was unsubscribed meanwhile.
  if (entry.settled !== settled || entry.withdrawn || worktreeEnvs.get(wtPath) !== entry) return;
  entry.withdrawn = true;
  startResolution(wtPath, entry);
}

function startResolution(wtPath: string, entry: WorktreePythonEnv): Promise<PythonEnv | null> {
  const env = buildSpawnEnv();
  const overridePath = getPythonOverride(wtPath);
  const onChange = () => {
    if (worktreeEnvs.get(wtPath) === entry) startResolution(wtPath, entry);
  };
  // Watch the layout before the first resolution so nothing created meanwhile is missed.
  entry.watch ??= watchPythonEnv(wtPath, null, onChange, { env });
  const detailed = resolveDetailed(wtPath, overridePath, env, envLookups(wtPath, env));
  const resolution = detailed.then(({ env: resolved }) => resolved);
  entry.resolution = resolution;
  entry.overridePath = overridePath;
  entry.pending = true;
  void detailed.then(({ env: resolved, projectDirs }) => {
    if (worktreeEnvs.get(wtPath) !== entry || entry.resolution !== resolution) return;
    const previous = entry.settled;
    entry.settled = { env: resolved, overridePath };
    entry.pending = false;
    entry.withdrawn = false;
    // Keep the old watch until the new one is armed, and hand a change it saw during resolution
    // to the new one's debounce, so a write burst coalesces into one more round.
    const oldWatch = entry.watch;
    entry.watch = watchPythonEnv(wtPath, resolved, onChange, { env, projectDirs });
    if (oldWatch?.hasPendingChange) entry.watch.nudge();
    oldWatch?.close();
    const changed =
      !previous ||
      previous.overridePath !== overridePath ||
      !isSamePythonEnv(previous.env, resolved);
    if (changed) {
      log.info("Python environment resolved", {
        wtPath,
        source: resolved?.source ?? null,
        pythonPath: resolved?.pythonPath ?? null,
      });
    }
    const update = { env: resolved, first: previous === null, changed };
    for (const listener of entry.listeners) {
      // One failing listener must not keep the update from the others.
      try {
        listener(update);
      } catch (err) {
        log.warn("A Python environment listener failed", { wtPath, error: err });
      }
    }
  });
  return resolution;
}

/** Whether two resolutions found the same interpreter, the same way. */
export function isSamePythonEnv(a: PythonEnv | null, b: PythonEnv | null): boolean {
  return a?.source === b?.source && a?.pythonPath === b?.pythonPath && a?.envPath === b?.envPath;
}

// ---------------------------------------------------------------------------
// Resolution

/**
 * Find the Python interpreter for a worktree, in order: the chosen override, `VIRTUAL_ENV` then
 * `CONDA_PREFIX` when they lie inside the worktree, the `UV_PROJECT_ENVIRONMENT` directory, a
 * `.venv` / `venv` / `env` virtual environment at the worktree root, Pixi's default environment,
 * Poetry's and Pipenv's environments (each only with its lock file and the tool on PATH), the
 * virtual environment of a Python project below the root when it is the only one, then
 * `python3` / `python` on the login-shell PATH. Any candidate counts only when its interpreter
 * exists, is executable, and is not a file the repository tracks. Never throws; returns null when
 * nothing is found. Uncached; Loxel's features share {@link getPythonEnv} instead.
 */
export async function resolvePythonEnv(
  worktreePath: string,
  options: ResolvePythonEnvOptions = {},
): Promise<PythonEnv | null> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  const overridePath =
    options.overridePath === undefined ? getPythonOverride(wtPath) : options.overridePath;
  return (await resolveDetailed(wtPath, overridePath, env, envLookups(wtPath, env))).env;
}

/** The lookups that spawn processes, each run at most once per resolution or listing. */
interface EnvLookups {
  tools: Record<EnvTool["source"], () => Promise<PythonEnv | null>>;
  system: () => Promise<PythonEnv | null>;
  projectDirs: () => Promise<string[]>;
}

function envLookups(wtPath: string, env: SpawnEnv): EnvLookups {
  return {
    tools: {
      poetry: once(() => toolEnv(wtPath, env, POETRY)),
      pipenv: once(() => toolEnv(wtPath, env, PIPENV)),
    },
    system: once(() => systemPython(wtPath, env)),
    projectDirs: once(() => pythonProjectDirs(wtPath)),
  };
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= load());
}

/** A resolution, with the project directories it searched for a sub-project environment, if any. */
interface DetailedResolution {
  env: PythonEnv | null;
  projectDirs: string[] | null;
}

async function resolveDetailed(
  wtPath: string,
  overridePath: string | null,
  env: SpawnEnv,
  lookups: EnvLookups,
): Promise<DetailedResolution> {
  const found = (resolved: PythonEnv | null) => ({ env: resolved, projectDirs: null });
  try {
    if (overridePath) {
      const override = await interpreterAt(wtPath, overridePath, "override");
      if (override) return found(override);
    }

    for (const [variable, source] of ACTIVATED_ENV_VARS) {
      const value = env[variable];
      const activated = value ? path.resolve(value) : null;
      if (!activated || !isInside(activated, wtPath)) continue;
      const active = await envAt(wtPath, activated, source);
      if (active) return found(active);
    }

    for (const dir of rootVenvDirs(wtPath, env)) {
      const venv = await venvAt(wtPath, dir);
      if (venv) return found(venv);
    }

    const pixi = await envAt(wtPath, path.join(wtPath, PIXI_ENV_DIR), "pixi");
    if (pixi) return found(pixi);

    for (const { source } of ENV_TOOLS) {
      const tool = await lookups.tools[source]();
      if (tool) return found(tool);
    }

    const projectDirs = await lookups.projectDirs();
    const nested = await onlyNestedVenv(wtPath, projectDirs);
    return { env: nested ?? (await lookups.system()), projectDirs };
  } catch (err) {
    log.warn("Python environment resolution failed", { wtPath, error: err });
    return found(null);
  }
}

/** Where a root virtual environment may be: uv's `UV_PROJECT_ENVIRONMENT` first, then the usual names. */
function rootVenvDirs(wtPath: string, env: SpawnEnv): string[] {
  const dirs = VENV_DIR_NAMES.map((name) => path.join(wtPath, name));
  const uvProjectEnv = env.UV_PROJECT_ENVIRONMENT;
  if (!uvProjectEnv) return dirs;
  const uvDir = path.resolve(wtPath, uvProjectEnv);
  return [uvDir, ...dirs.filter((dir) => dir !== uvDir)];
}

/**
 * The virtual environment of a Python project below the root, when exactly one such project has
 * one (a monorepo without a root environment); none when several do, since which one a file needs
 * depends on the file.
 */
async function onlyNestedVenv(wtPath: string, projectDirs: string[]): Promise<PythonEnv | null> {
  const venvs = await Promise.all(
    projectDirs.flatMap((dir) =>
      VENV_DIR_NAMES.map(async (name) => {
        const venv = path.join(dir, name);
        return (await isVenvWithInterpreter(venv)) ? venv : null;
      }),
    ),
  );
  const existing = venvs.filter((venv) => venv !== null);
  return existing.length === 1 ? venvAt(wtPath, existing[0]!) : null;
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
 * Poetry's environment, the interpreter on the login-shell PATH, and last the chosen override
 * when it is none of those. Never throws.
 */
export async function listPythonEnvs(
  worktreePath: string,
  options: Pick<ResolvePythonEnvOptions, "env"> = {},
): Promise<PythonEnvChoices> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  const lookups = envLookups(wtPath, env);
  try {
    const overridePath = getPythonOverride(wtPath);
    const projectDirs = [wtPath, ...(await lookups.projectDirs())];
    const [automatic, ...found] = await Promise.all([
      resolveDetailed(wtPath, null, env, lookups).then((resolved) => resolved.env),
      ...projectDirs.flatMap((dir) => [
        ...VENV_DIR_NAMES.map((name) => venvAt(wtPath, path.join(dir, name))),
        ...pixiEnvDirs(dir).map((envPath) => envAt(wtPath, envPath, "pixi")),
      ]),
      lookups.tools.poetry(),
      lookups.system(),
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
 * meant for the user when the path is not an executable file or the repository tracks it or any
 * file of its environment.
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
    if (await isInterpreterShippedByRepo(wtPath, pythonPath)) {
      throw new Error(
        "Loxel does not run a Python interpreter or environment that the repository tracks in git",
      );
    }
    return pythonPath;
  }
  throw new Error(`No executable Python interpreter at ${target}`);
}

// ---------------------------------------------------------------------------
// Watching

export interface WatchPythonEnvOptions {
  /** Environment for `UV_PROJECT_ENVIRONMENT`. Defaults to none. */
  env?: SpawnEnv;
  /** Project directories below the root whose virtual environments the resolution counted. */
  projectDirs?: readonly string[] | null;
}

/**
 * Call `onChange` (debounced) when the worktree's Python environment may have changed: a
 * candidate environment appearing, disappearing or being populated, a Poetry or Pipenv lock file
 * changing, or `current` being recreated or receiving packages. Watches are non-recursive and
 * fixed to the layout seen now, so callers re-resolve and re-watch on every change; to not lose a
 * change made while re-resolving, keep the old watch until the new one is armed and check its
 * `hasPendingChange` before closing it.
 */
export function watchPythonEnv(
  worktreePath: string,
  current: PythonEnv | null,
  onChange: () => void,
  options: WatchPythonEnvOptions = {},
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
  for (const [dir, names] of watchTargets(path.resolve(worktreePath), current, options)) {
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
function watchTargets(
  wtPath: string,
  current: PythonEnv | null,
  { env = {}, projectDirs }: WatchPythonEnvOptions,
): Map<string, Set<string> | null> {
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

  const candidates = [
    ...rootVenvDirs(wtPath, env),
    path.join(wtPath, PIXI_ENV_DIR),
    ...(projectDirs ?? []).flatMap((dir) => VENV_DIR_NAMES.map((name) => path.join(dir, name))),
  ];
  for (const candidate of candidates) {
    if (isDirectory(candidate)) {
      for (const name of [...interpreterDirNames(), "pyvenv.cfg", "conda-meta"]) {
        add(candidate, name);
      }
      addInterpreterDirs(candidate);
      continue;
    }
    let missing = candidate;
    while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
      missing = path.dirname(missing);
    }
    add(path.dirname(missing), path.basename(missing));
  }
  for (const { lockFile } of ENV_TOOLS) add(wtPath, lockFile);

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

// ---------------------------------------------------------------------------
// Candidates

async function envAt(
  wtPath: string,
  envPath: string,
  source: PythonEnvSource,
): Promise<PythonEnv | null> {
  for (const relative of interpreterRelativePaths()) {
    const pythonPath = path.join(envPath, relative);
    if (!(await isExecutable(pythonPath))) continue;
    if (await isEnvShippedByRepo(wtPath, envPath, pythonPath)) {
      log.warn("Ignoring a Python environment with files tracked by git", {
        wtPath,
        envPath,
        pythonPath,
      });
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

/** Whether `dir` is a virtual environment with an executable interpreter, before any trust check. */
async function isVenvWithInterpreter(dir: string): Promise<boolean> {
  if (!(await Bun.file(path.join(dir, "pyvenv.cfg")).exists())) return false;
  for (const relative of interpreterRelativePaths()) {
    if (await isExecutable(path.join(dir, relative))) return true;
  }
  return false;
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
  if (await isInterpreterShippedByRepo(wtPath, pythonPath)) {
    log.warn("Ignoring a Python interpreter tracked by git", { wtPath, pythonPath });
    return null;
  }
  return { source, pythonPath, envPath: await envPrefixOf(pythonPath) };
}

async function systemPython(wtPath: string, env: SpawnEnv): Promise<PythonEnv | null> {
  // PATH can include a directory of the worktree itself (direnv's `PATH_add bin`).
  const PATH = env.PATH ?? "";
  for (const name of ["python3", "python"]) {
    // Entry by entry, so a tracked hit early on PATH does not hide a real interpreter later.
    for (const dir of PATH.split(path.delimiter)) {
      const system = dir ? Bun.which(name, { PATH: dir }) : null;
      // The environment rule too, so PATH cannot hand back an interpreter from an environment
      // the checks above rejected (direnv's `PATH_add .venv/bin`).
      if (system && !(await isInterpreterShippedByRepo(wtPath, system))) {
        return { source: "system", pythonPath: system, envPath: null };
      }
    }
  }
  return null;
}

/**
 * The environment a project tool (Poetry, Pipenv) keeps for the worktree, asked only when the
 * tool's lock file exists at the root and the tool is on PATH, since it is a process spawn.
 */
async function toolEnv(wtPath: string, env: SpawnEnv, tool: EnvTool): Promise<PythonEnv | null> {
  if (!(await Bun.file(path.join(wtPath, tool.lockFile)).exists())) return null;
  const executable = Bun.which(tool.command, { PATH: env.PATH ?? "" });
  if (!executable) return null;

  // Both report an activated environment as the project's own, so hide the one Loxel was
  // launched with.
  const { VIRTUAL_ENV: _venv, CONDA_PREFIX: _conda, PIPENV_ACTIVE: _pipenv, ...toolEnvVars } = env;
  try {
    const proc = measureSpawn("python-env", () =>
      Bun.spawn([executable, ...tool.args], {
        cwd: wtPath,
        env: toolEnvVars,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: ENV_TOOL_TIMEOUT_MS,
      }),
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // Exits non-zero when the project has no environment yet.
    const envPath = stdout.trim().split("\n").at(-1)?.trim();
    if (exitCode !== 0 || !envPath) return null;
    return await envAt(wtPath, envPath, tool.source);
  } catch (err) {
    log.debug("Asking a project tool for its environment failed", {
      wtPath,
      tool: tool.source,
      error: err,
    });
    return null;
  }
}

/**
 * Directories below the worktree root (not the root itself) holding a Python project marker,
 * from git's view of the tree, so ignored directories such as `node_modules` are skipped.
 */
async function pythonProjectDirs(wtPath: string): Promise<string[]> {
  const listed = await runGit(wtPath, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...PROJECT_MARKERS.map((marker) => `:(glob)**/${marker}`),
  ]);
  if (listed.exitCode !== 0) return [];
  const dirs = new Set<string>();
  for (const file of listed.stdout.split("\0")) {
    const dir = path.posix.dirname(file);
    if (!file || dir === "." || dir.split("/").length > MAX_PROJECT_DEPTH) continue;
    dirs.add(dir);
  }
  return [...dirs]
    .toSorted()
    .slice(0, MAX_PROJECT_DIRS)
    .map((dir) => path.join(wtPath, dir));
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

// ---------------------------------------------------------------------------
// The trust rule

/** The trust rule for an environment the resolver returned, as it was checked when found. */
function isResolvedEnvShipped(wtPath: string, env: PythonEnv): Promise<boolean> {
  return env.envPath
    ? isEnvShippedByRepo(wtPath, env.envPath, env.pythonPath)
    : isInterpreterShippedByRepo(wtPath, env.pythonPath);
}

/** `isEnvShippedByRepo` for an interpreter given by path: its environment, if it is in one. */
async function isInterpreterShippedByRepo(wtPath: string, pythonPath: string): Promise<boolean> {
  const envPath = await envPrefixOf(pythonPath);
  return envPath
    ? isEnvShippedByRepo(wtPath, envPath, pythonPath)
    : isShippedByRepo(wtPath, pythonPath);
}

// ---------------------------------------------------------------------------
// Layout helpers

/** The environment directory an interpreter belongs to, if it is a venv or conda environment. */
async function envPrefixOf(pythonPath: string): Promise<string | null> {
  const binDir = path.dirname(pythonPath);
  for (const prefix of [path.dirname(binDir), binDir]) {
    if (await Bun.file(path.join(prefix, "pyvenv.cfg")).exists()) return prefix;
    if (isDirectory(path.join(prefix, "conda-meta"))) return prefix;
  }
  return null;
}

/** The directory of an environment holding its executables (`bin`, or `Scripts` on Windows). */
export function envBinDir(envPath: string): string {
  return path.join(envPath, IS_WINDOWS ? "Scripts" : "bin");
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

/**
 * `PATH` without the worktree's own directories, for processes that look up `python` themselves
 * (basedpyright, when no interpreter was resolved), so they cannot pick up one the repository ships.
 */
export function pathOutsideWorktree(PATH: string, wtPath: string): string {
  const root = path.resolve(wtPath);
  return PATH.split(path.delimiter)
    .filter((dir) => dir && !isInside(path.resolve(root, dir), root))
    .join(path.delimiter);
}
