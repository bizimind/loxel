import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { $ } from "bun";

export const PYTHON_FORMAT_EXTENSIONS: readonly string[] = ["py", "pyi"];

export interface PythonFormatter {
  command: "ruff" | "black";
  args: string;
}

/** `--force-exclude` makes ruff honor its `exclude` settings for stdin input (it echoes excluded files unchanged). */
const RUFF: PythonFormatter = {
  command: "ruff",
  args: "format --force-exclude --stdin-filename {file}",
};

/** Black applies `force-exclude` to `--stdin-filename` on its own, and infers stub style from `.pyi`. */
const BLACK: PythonFormatter = { command: "black", args: "--quiet --stdin-filename {file} -" };

/** Ruff's own config file names, highest precedence first (as ruff resolves them). */
const RUFF_CONFIG_FILES = [".ruff.toml", "ruff.toml"];

const VENV_DIR_NAMES = [".venv", "venv"];

/**
 * Pick the Python formatter for files under `startDir`, walking up to `wtRoot`; ruff and black
 * then resolve their own nested config from `--stdin-filename`.
 *
 * A ruff config or dependency often exists for the linter alone, while black's only job is
 * formatting. So the nearest directory with a formatting signal decides: a ruff config with a
 * `format` table selects ruff, a `[tool.black]` table or black dependency selects black. A ruff
 * config without `format`, or a ruff dependency, selects ruff only when no such signal exists up
 * to the root. A bare `pyproject.toml` formats nothing, like prettier and oxfmt need a config or
 * dependency: formatting a project with a tool it never chose would rewrite every file it saves.
 *
 * Not cached: a save costs a few `existsSync` calls per directory level plus parsing the
 * `pyproject.toml` files on the way, negligible next to spawning the formatter.
 */
export function detectPythonFormatter(startDir: string, wtRoot: string): PythonFormatter | null {
  let ruffWithoutFormat = false;
  for (const dir of dirsUpToRoot(startDir, wtRoot)) {
    const pyproject = readToml(join(dir, "pyproject.toml"));
    const tool = recordAt(pyproject, "tool");
    const ruff = readRuffConfig(dir) ?? recordAt(tool, "ruff");
    const declared = pyproject ? declaredDependencies(pyproject) : [];
    if (recordAt(ruff, "format")) return RUFF;
    if (recordAt(tool, "black") || declared.includes("black")) return BLACK;
    if (ruff || declared.includes("ruff")) ruffWithoutFormat = true;
  }
  return ruffWithoutFormat ? RUFF : null;
}

/**
 * `bin` of the nearest virtual environment (`.venv` or `venv` holding a `pyvenv.cfg`) from
 * `startDir` up to `wtRoot`, so formatters pinned in the project's dev dependencies win over
 * global installs. Venvs with files tracked by git are skipped: a cloned repo that commits
 * `.venv/bin/ruff` would otherwise run its own code on every save. Deliberately minimal; to be
 * unified with the server's Python environment resolver.
 */
export async function findVenvBin(startDir: string, wtRoot: string): Promise<string | undefined> {
  for (const dir of dirsUpToRoot(startDir, wtRoot)) {
    for (const name of VENV_DIR_NAMES) {
      const venv = join(dir, name);
      if (!existsSync(join(venv, "pyvenv.cfg"))) continue;
      if (await isTrackedByGit(venv, wtRoot)) continue;
      return join(venv, "bin");
    }
  }
  return undefined;
}

/**
 * Whether git tracks any file in each venv directory seen, kept until the worktree's formatter
 * state is invalidated (`forgetVenvTracking`): a venv's tracked status rarely changes, and saves
 * should not spawn git each time.
 */
const venvTracked = new Map<string, Promise<boolean>>();

function isTrackedByGit(venv: string, wtRoot: string): Promise<boolean> {
  let tracked = venvTracked.get(venv);
  if (!tracked) {
    // Outside a git repo `ls-files` fails, and nothing can be tracked.
    tracked = $`git -C ${wtRoot} ls-files -- ${venv}`
      .quiet()
      .text()
      .then(
        (out) => out.trim().length > 0,
        () => false,
      );
    venvTracked.set(venv, tracked);
  }
  return tracked;
}

/** Drop cached venv tracking state for venvs inside `wtRoot`. */
export function forgetVenvTracking(wtRoot: string): void {
  const prefix = resolve(wtRoot) + sep;
  for (const venv of venvTracked.keys()) {
    if (venv.startsWith(prefix)) venvTracked.delete(venv);
  }
}

/** `startDir` and its ancestors up to `wtRoot` (inclusive); just `wtRoot` when outside it. */
function dirsUpToRoot(startDir: string, wtRoot: string): string[] {
  const root = resolve(wtRoot);
  let dir = resolve(root, startDir);
  const rel = relative(root, dir);
  // Lexical check: callers pass the file path in the same form as the worktree path.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [root];
  const dirs = [dir];
  while (dir !== root) {
    dir = dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}

/** The ruff config table from `.ruff.toml` / `ruff.toml` in `dir` (empty when unparsable). */
function readRuffConfig(dir: string): Record<string, unknown> | undefined {
  for (const name of RUFF_CONFIG_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) return readToml(path) ?? {};
  }
  return undefined;
}

function readToml(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // An unparsable file contributes nothing; the formatter reports the error if it runs.
    return undefined;
  }
}

/**
 * Normalized names of the packages a `pyproject.toml` depends on: PEP 621 dependencies and
 * extras, PEP 735 dependency groups, uv, Poetry and PDM dev dependencies, and Hatch environments.
 */
function declaredDependencies(pyproject: Record<string, unknown>): string[] {
  const project = recordAt(pyproject, "project");
  const tool = recordAt(pyproject, "tool");
  const poetry = recordAt(tool, "poetry");
  const requirements = [
    project?.dependencies,
    ...Object.values(recordAt(project, "optional-dependencies") ?? {}),
    ...Object.values(recordAt(pyproject, "dependency-groups") ?? {}),
    recordAt(tool, "uv")?.["dev-dependencies"],
    ...Object.values(recordAt(recordAt(tool, "pdm"), "dev-dependencies") ?? {}),
    ...Object.values(recordAt(recordAt(tool, "hatch"), "envs") ?? {}).flatMap((env) =>
      isRecord(env) ? [env.dependencies, env["extra-dependencies"]] : [],
    ),
  ].flatMap((list) => (Array.isArray(list) ? list : []));
  const poetryTables = [
    recordAt(poetry, "dependencies"),
    recordAt(poetry, "dev-dependencies"),
    ...Object.values(recordAt(poetry, "group") ?? {}).map((g) => recordAt(g, "dependencies")),
  ];
  return [
    ...requirements.flatMap((r) => (typeof r === "string" ? [requirementName(r)] : [])),
    ...poetryTables.flatMap((t) => Object.keys(t ?? {})),
  ].map(normalizePackageName);
}

/** The distribution name at the start of a PEP 508 requirement (`"ruff>=0.5"` → `"ruff"`). */
function requirementName(requirement: string): string {
  return /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1] ?? "";
}

/** PEP 503 name normalization. */
function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
