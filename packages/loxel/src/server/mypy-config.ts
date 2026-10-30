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
  /** Whether the config says what to check (`files`, `modules` or `packages`). */
  hasTargets: boolean;
}

/** What one config file holds for mypy: null when it is not a mypy config. */
type ParsedConfig = { hasTargets: boolean } | null;

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
      if (config) return { dir, file, hasTargets: config.hasTargets };
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
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
    if (!toml) return /^\[tool\.mypy\]/m.test(text) ? { hasTargets: false } : null;
    const mypy = recordAt(recordAt(toml, "tool"), "mypy");
    return mypy ? { hasTargets: TARGET_KEYS.some((key) => key in mypy) } : null;
  }
  const keys = iniSectionKeys(text, "mypy");
  // mypy takes a `mypy.ini` / `.mypy.ini` even without a `[mypy]` section, but skips a
  // `setup.cfg` that has none.
  if (!keys && name === "setup.cfg") return null;
  return { hasTargets: TARGET_KEYS.some((key) => keys?.has(key)) };
}

/** The keys set in `section` of an INI file, or null when it has no such section. */
export function iniSectionKeys(text: string, section: string): Set<string> | null {
  let keys: Set<string> | null = null;
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      inSection = header[1]?.trim() === section;
      if (inSection) keys ??= new Set();
      continue;
    }
    // Indented lines continue the previous value; comments start with `#` or `;`.
    const key = inSection ? /^([^\s#;=:][^=:]*?)\s*[=:]/.exec(line)?.[1] : undefined;
    if (key) keys?.add(key.trim());
  }
  return keys;
}
