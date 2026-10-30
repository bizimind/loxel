/**
 * Finding the mypy configuration that governs a Python file, the way mypy finds its own when run
 * from a directory: in each directory, `mypy.ini`, `.mypy.ini`, then a `pyproject.toml` with a
 * `[tool.mypy]` table, then a `setup.cfg` with a `[mypy]` section.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseToml, recordAt } from "./toml-file";

/** The file names mypy reads its configuration from, in the order it tries them per directory. */
export const MYPY_CONFIG_FILES = ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"] as const;

/** Config keys that name what to check, so mypy needs no targets on its command line. */
const TARGET_KEYS = ["files", "modules", "packages"];

export interface MypyConfig {
  /** The directory holding the config file, where mypy runs. */
  dir: string;
  /** The config file. */
  file: string;
  /**
   * The paths the config's targets name, relative to `dir`, or null when it names none (mypy
   * then checks the open files): `files` entries
   * (paths or globs), and where the `modules` and `packages` it names would be found (`<module>.py`,
   * `<module>.pyi`, the package directory) under `dir`, `src` and the config's `mypy_path`.
   */
  targets: string[] | null;
}

/** What one config file holds for mypy: null when it is not a mypy config. */
type ParsedConfig = Pick<MypyConfig, "targets"> | null;

/** Parsed config files by path, reused while their size and modification time stay the same. */
const parsed = new Map<string, { mtimeMs: number; size: number; config: ParsedConfig }>();

/**
 * The mypy configuration nearest to `filePath`, searching its directory and each parent up to
 * `wtPath`, or null when none of them has one (user-level configs do not count: they say nothing
 * about the project). Config files are re-read only when they change, so this is cheap to call for
 * every diagnostics report.
 */
export function findMypyConfig(filePath: string, wtPath: string): MypyConfig | null {
  const root = path.resolve(wtPath);
  let dir = path.dirname(path.resolve(filePath));
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  while (true) {
    for (const name of MYPY_CONFIG_FILES) {
      const file = path.join(dir, name);
      const config = readConfig(file);
      if (config) return { dir, file, ...config };
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Whether checking `config`'s project checks `filePath`: any file when mypy checks open files, else
 * a file its targets cover (a path, a directory holding it, or a glob). mypy's `exclude` is not
 * applied, and modules mypy follows imports into are not covered.
 */
export function coversFile(config: MypyConfig, filePath: string): boolean {
  if (!config.targets) return true;
  const file = path.resolve(filePath);
  return config.targets.some((entry) => {
    const target = path.resolve(config.dir, entry);
    if (file === target || file.startsWith(target + path.sep)) return true;
    return /[*?[]/.test(entry) && new Bun.Glob(target).match(file);
  });
}

/** Whether `filePath` is one of the files mypy reads its configuration from. */
export function isMypyConfigFile(filePath: string): boolean {
  return (MYPY_CONFIG_FILES as readonly string[]).includes(path.basename(filePath));
}

function readConfig(file: string): ParsedConfig {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    parsed.delete(file);
    return null;
  }
  const cached = parsed.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.config;
  const config = parseConfig(file);
  parsed.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, config });
  return config;
}

function parseConfig(file: string): ParsedConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const name = path.basename(file);
  if (name === "pyproject.toml") {
    const toml = parseToml(text);
    // A file broken mid-edit still names mypy's table: mypy runs and reports the error.
    if (!toml) return /^\[tool\.mypy\]/m.test(text) ? { targets: null } : null;
    const mypy = recordAt(recordAt(toml, "tool"), "mypy");
    if (!mypy) return null;
    return parsedTargets((key) => tomlList(mypy[key]));
  }
  const values = iniSection(text, "mypy");
  // mypy takes a `mypy.ini` / `.mypy.ini` even without a `[mypy]` section, but skips a
  // `setup.cfg` that has none.
  if (!values && name === "setup.cfg") return null;
  return parsedTargets((key) => {
    const value = values?.get(key);
    if (value === undefined) return null;
    // `mypy_path` is also separated by colons.
    return splitList(value, key === "mypy_path" ? /[,:]/ : /,/);
  });
}

/** The targets of a config whose list-valued keys `list` reads (null: the key is not set). */
function parsedTargets(list: (key: string) => string[] | null): ParsedConfig {
  const [files, modules, packages] = TARGET_KEYS.map(list);
  if (!files && !modules && !packages) return { targets: null };
  // Where mypy would find modules and packages: the config's directory, a `src` layout, and
  // `mypy_path` entries (those relative to the config; `$MYPY_CONFIG_FILE_DIR` ones are skipped).
  const roots = [".", "src", ...(list("mypy_path") ?? []).filter((dir) => !dir.includes("$"))];
  const asPath = (name: string) => name.replaceAll(".", "/");
  const targets = [
    ...(files ?? []),
    ...(modules ?? []).flatMap((module) =>
      roots.flatMap((root) => {
        const base = path.join(root, asPath(module));
        return [`${base}.py`, `${base}.pyi`, base];
      }),
    ),
    ...(packages ?? []).flatMap((pkg) => roots.map((root) => path.join(root, asPath(pkg)))),
  ];
  return { targets };
}

/** A TOML value mypy reads as a list: an array of strings, or a comma-separated string. */
function tomlList(value: unknown): string[] | null {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? splitList(value, /,/) : null;
}

/** A separated list, as mypy reads list-valued options from INI files and TOML strings. */
function splitList(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The values set in `section` of an INI file, by key, or null when it has no such section.
 * Indented lines continue the previous value, as `configparser` reads them.
 */
export function iniSection(text: string, section: string): Map<string, string> | null {
  let values: Map<string, string> | null = null;
  let inSection = false;
  let lastKey: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      inSection = header[1]?.trim() === section;
      if (inSection) values ??= new Map();
      lastKey = null;
      continue;
    }
    if (!inSection || !values || /^\s*[#;]/.test(line)) continue;
    if (lastKey && /^\s+\S/.test(line)) {
      values.set(lastKey, `${values.get(lastKey) ?? ""} ${line.trim()}`.trim());
      continue;
    }
    const entry = /^([^\s=:][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (!entry) continue;
    lastKey = entry[1]?.trim() ?? null;
    if (lastKey) values.set(lastKey, entry[2]?.trim() ?? "");
  }
  return values;
}
