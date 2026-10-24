import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import type { PythonEnv, PythonEnvSource } from "@/api/python-env-model";
import { isWithin } from "@/lib/project-file-helpers";

import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("server");

/** Virtual environment directories looked for at the worktree root (uv, uv workspaces, PDM, `python -m venv`). */
const VENV_DIR_NAMES = [".venv", "venv", "env"] as const;
/** Pixi's default environment, relative to the worktree root. */
const PIXI_ENV_DIR = ".pixi/envs/default";
const POETRY_LOCK = "poetry.lock";
const POETRY_TIMEOUT_MS = 10_000;
/** Quiet period after the last filesystem event before re-resolving (installers write in bursts). */
const WATCH_DEBOUNCE_MS = 1000;

const IS_WINDOWS = process.platform === "win32";

export interface ResolvePythonEnvOptions {
  /** Interpreter chosen explicitly for this worktree; wins whenever it is executable. */
  overridePath?: string | null;
  /** Environment for `VIRTUAL_ENV` and PATH lookups. Defaults to the login-shell spawn environment. */
  env?: Record<string, string | undefined>;
}

/**
 * Find the Python interpreter for a worktree, in order: the explicit override, `VIRTUAL_ENV` when
 * it lies inside the worktree, a `.venv` / `venv` / `env` virtual environment at the worktree
 * root, Pixi's default environment, Poetry's environment (only with a `poetry.lock` and `poetry`
 * on PATH), then `python3` / `python` on the login-shell PATH. A candidate counts only when its
 * interpreter exists and is executable. Never throws; returns null when nothing is found.
 */
export async function resolvePythonEnv(
  wtPath: string,
  options: ResolvePythonEnvOptions = {},
): Promise<PythonEnv | null> {
  const env = options.env ?? buildSpawnEnv();
  try {
    if (options.overridePath && (await isExecutable(options.overridePath))) {
      return {
        source: "override",
        pythonPath: options.overridePath,
        envPath: await envPrefixOf(options.overridePath),
      };
    }

    const virtualEnv = env.VIRTUAL_ENV ? path.resolve(env.VIRTUAL_ENV) : null;
    if (virtualEnv && isWithin(virtualEnv, wtPath)) {
      const found = await envAt(virtualEnv, "virtual-env");
      if (found) return found;
    }

    for (const name of VENV_DIR_NAMES) {
      const dir = path.join(wtPath, name);
      if (!(await Bun.file(path.join(dir, "pyvenv.cfg")).exists())) continue;
      const found = await envAt(dir, "venv");
      if (found) return found;
    }

    const pixi = await envAt(path.join(wtPath, PIXI_ENV_DIR), "pixi");
    if (pixi) return pixi;

    const poetry = await poetryEnv(wtPath, env);
    if (poetry) return poetry;

    const PATH = env.PATH ?? "";
    const system = Bun.which("python3", { PATH }) ?? Bun.which("python", { PATH });
    return system ? { source: "system", pythonPath: system, envPath: null } : null;
  } catch (err) {
    log.warn("Python environment resolution failed", { wtPath, error: err });
    return null;
  }
}

/**
 * Call `onChange` (debounced) when the worktree's Python environment may have changed: a
 * candidate environment appearing, disappearing or being populated, `poetry.lock` changing, or
 * packages being installed into `current`'s site-packages. Watches are non-recursive and fixed
 * to the layout seen now, so callers re-resolve and re-watch on every change. Returns a disposer.
 */
export function watchPythonEnv(
  wtPath: string,
  current: PythonEnv | null,
  onChange: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  };

  const watchers: FSWatcher[] = [];
  for (const [dir, names] of watchTargets(wtPath, current)) {
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

  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
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
  }
  add(wtPath, POETRY_LOCK);

  if (current?.envPath) {
    for (const dir of sitePackagesDirs(current.envPath)) add(dir, null);
  }
  return targets;
}

async function envAt(envPath: string, source: PythonEnvSource): Promise<PythonEnv | null> {
  for (const relative of interpreterRelativePaths()) {
    const pythonPath = path.join(envPath, relative);
    if (await isExecutable(pythonPath)) return { source, pythonPath, envPath };
  }
  return null;
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

  const proc = Bun.spawn([poetry, "env", "info", "--path"], {
    cwd: wtPath,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: POETRY_TIMEOUT_MS,
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // Exits non-zero when the project has no environment yet.
  const envPath = stdout.trim();
  if (exitCode !== 0 || !envPath) return null;
  return envAt(envPath, "poetry");
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

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
