import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PYTHON_FORMAT_EXTENSIONS = ["py", "pyi"];

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
 * Pick the Python formatter for files under `startDir`, walking up to `wtRoot`. The nearest
 * directory with formatter config decides; ruff and black then resolve their own nested config
 * from `--stdin-filename`. Without config anywhere, a ruff or black dependency declared in a
 * `pyproject.toml` on the way up opts the project in. A bare `pyproject.toml` formats nothing,
 * like prettier and oxfmt need a config or dependency: formatting a project with a tool it never
 * chose would rewrite every file it saves.
 *
 * Black wins over ruff unless ruff's formatter is configured explicitly: a `[tool.ruff]` table
 * or ruff dependency often exists for the linter alone, while black's only job is formatting.
 *
 * Not cached: a save costs a few `existsSync` calls per directory level plus parsing the
 * `pyproject.toml` files on the way, negligible next to spawning the formatter.
 */
export function detectPythonFormatter(startDir: string, wtRoot: string): PythonFormatter | null {
  const declared = new Set<string>();
  for (const dir of dirsUpToRoot(startDir, wtRoot)) {
    const ruffConfig = readRuffConfig(dir);
    const pyproject = readToml(join(dir, "pyproject.toml"));
    const tool = pyproject ? recordAt(pyproject, "tool") : undefined;
    const hasBlack = recordAt(tool, "black") !== undefined;
    const ruff = ruffConfig ?? recordAt(tool, "ruff");
    if (hasBlack && recordAt(ruff, "format") === undefined) return BLACK;
    if (ruff) return RUFF;
    if (pyproject) for (const name of declaredDependencies(pyproject)) declared.add(name);
  }
  if (declared.has("black")) return BLACK;
  if (declared.has("ruff")) return RUFF;
  return null;
}

/**
 * `bin` of the nearest virtual environment (`.venv` or `venv` holding a `pyvenv.cfg`) from
 * `startDir` up to `wtRoot`, so formatters pinned in the project's dev dependencies win over
 * global installs. Deliberately minimal; to be unified with the server's Python environment
 * resolver.
 */
export function findVenvBin(startDir: string, wtRoot: string): string | undefined {
  for (const dir of dirsUpToRoot(startDir, wtRoot)) {
    for (const name of VENV_DIR_NAMES) {
      if (existsSync(join(dir, name, "pyvenv.cfg"))) return join(dir, name, "bin");
    }
  }
  return undefined;
}

/** `startDir` and its ancestors up to `wtRoot` (inclusive); just `wtRoot` when outside it. */
function dirsUpToRoot(startDir: string, wtRoot: string): string[] {
  const root = resolve(wtRoot);
  let dir = resolve(root, startDir);
  const rel = relative(root, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) return [root];
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
 * extras, PEP 735 dependency groups, and the uv, Poetry and PDM dev-dependency tables.
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
