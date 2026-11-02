import { readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, posix, resolve } from "node:path";

import {
  dirsUpToRoot,
  type FileFormatter,
  type FormatterFailure,
  type FormatterSpawnOptions,
  type LanguageFormatter,
} from "./language-formatter";
import { logger } from "./logger";
import { pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("format");

const CLANG_FORMAT = "clang-format";
/** clang-format finds the nearest config from this path by itself, and merges what inherits. */
const FORMATTER: FileFormatter = { command: CLANG_FORMAT, args: "--assume-filename={file}" };

/** The first line it prints for each way a config fails, checked against 23.1.3. */
const CONFIG_ERROR =
  /:\d+:\d+: error:|^Configuration file\(s\) do\(es\) not support|^Error reading /;

const CONFIG_FILES = [".clang-format", "_clang-format"];
const IGNORE_FILE = ".clang-format-ignore";
/** Far above any real config; a larger file does not count. */
const MAX_CONFIG_BYTES = 1_024 * 1_024;
/** Far above any real ignore file. */
const MAX_IGNORE_BYTES = 64 * 1_024;
/** Far above what real patterns take on one file, and small enough not to be felt on a save. */
const MAX_MATCH_STEPS = 5_000_000;

/**
 * The C-family extensions of `EXT_TO_LANG` in `highlighter.ts`, kept in step by a test, without `.m`
 * and `.i`: they are also MATLAB and SWIG, which clang-format rewrites into something else, with no
 * error. A statement can end up inside a comment. A manual override formats them on request.
 */
export const clangFormatter: LanguageFormatter = {
  extensions: [
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "c++",
    "ii",
    "ino",
    "hpp",
    "hh",
    "hxx",
    "h++",
    "inl",
    "ipp",
    "tpp",
    "tcc",
    "txx",
    "ixx",
    "cppm",
    "ccm",
    "cxxm",
    "c++m",
    "mm",
  ],
  detect: detectClangFormat,
  spawnOptions: clangFormatSpawnOptions,
  failureNotice: clangFormatFailureNotice,
};

/**
 * clang-format for a file in `startDir` with a config between it and `wtRoot`, since without one it
 * applies LLVM style to projects that never asked for it. Not for a file its ignore file covers.
 * Not cached: a save costs a few `statSync` calls per directory level plus reading one ignore file.
 */
function detectClangFormat(
  startDir: string,
  wtRoot: string,
  fileName?: string,
): FileFormatter | null {
  const root = resolve(wtRoot);
  const dir = resolve(root, startDir);
  const dirs = dirsUpToRoot(dir, root);
  // Outside the worktree, the config that applies is not one this walk can see.
  if (dirs[0] !== dir) return null;
  if (!hasUsableConfig(dirs)) return null;
  return fileName && isIgnored(join(dir, fileName), dirs) ? null : FORMATTER;
}

/** Whether the file clang-format would pick is one to run it on; a too large one does not pass. */
function hasUsableConfig(dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    for (const name of CONFIG_FILES) {
      const size = regularFileSize(join(dir, name));
      if (size !== undefined) return size <= MAX_CONFIG_BYTES;
    }
  }
  return false;
}

/** The size of `path` when clang-format would read it: only a regular file, which a link can be. */
function regularFileSize(path: string): number | undefined {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    return info?.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the nearest `.clang-format-ignore` covers `filePath`. Current clang-format checks this on
 * stdin too, but only for a file already on disk, and older versions not at all, so a first save
 * or an older binary would otherwise reformat an ignored file. An ignore file too large to read
 * counts as covering it: leaving a file alone is easier to notice and undo than rewriting it.
 */
function isIgnored(filePath: string, dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    const path = join(dir, IGNORE_FILE);
    const size = regularFileSize(path);
    if (size === undefined) continue;
    if (size > MAX_IGNORE_BYTES) {
      log.warn("Ignore file is too large to read; not formatting", { path });
      return true;
    }
    return isIgnoredBy(readFileSync(path, "latin1"), latin1(dir), latin1(filePath));
  }
  return false;
}

/** Text with one character per UTF-8 byte, since clang-format's `?` and `[...]` match bytes. */
function latin1(text: string): string {
  return Buffer.from(text).toString("latin1");
}

/** clang-format's rules: comments and blanks skipped, `!` negates, and the last match decides. */
function isIgnoredBy(ignoreFile: string, ignoreDir: string, filePath: string): boolean {
  const budget = { steps: MAX_MATCH_STEPS };
  let ignored = false;
  for (const line of ignoreFile.split("\n")) {
    const entry = line.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
    if (!entry || entry.startsWith("#")) continue;
    const negated = entry.startsWith("!");
    const pattern = (negated ? entry.slice(1) : entry).replace(/^[ \t\n\v\f\r]+/, "");
    if (!pattern) continue;
    // Patterns are relative to the ignore file's directory, unless they start with a slash.
    const absolute = pattern.startsWith("/") ? pattern : withoutDots(ignoreDir, pattern);
    if (matchesGlob(absolute, filePath, budget)) ignored = !negated;
  }
  return ignored;
}

function withoutDots(dir: string, pattern: string): string {
  const joined = posix.join(dir, pattern);
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

/**
 * The behavior of clang's `MatchFilePath.cpp`, which clang-format uses for ignore files: POSIX `*`, `?`, `[...]` and `\`, where none of them cross a
 * `/`, plus `**` as a whole path segment. A pattern is the repository's, and this runs on the
 * server's thread, so a position that failed once is never tried again, and running out of `budget`
 * throws, which format-service takes as no formatter: the file is left alone.
 */
function matchesGlob(pattern: string, path: string, budget: { steps: number }): boolean {
  const failed = new Set<number>();
  const spend = (steps: number) => {
    budget.steps -= steps;
    if (budget.steps < 0) throw new Error("Ignore file patterns are too complex to match");
  };

  const matchFrom = (start: number, at: number): boolean => {
    spend(1);
    const key = start * (path.length + 1) + at;
    if (failed.has(key)) return false;
    const matched = match(start, at);
    if (!matched) failed.add(key);
    return matched;
  };

  const match = (start: number, from: number): boolean => {
    let i = start;
    let at = from;
    for (; at < path.length; at++) {
      spend(1);
      if (i === pattern.length) return false;
      const char = path[at];
      const token = pattern[i];
      if (token === "*") return matchStar(i, at);
      if (token === "?") {
        if (char === "/") return false;
        i++;
        continue;
      }
      if (token === "\\") {
        if (pattern[i + 1] !== char) return false;
        i += 2;
        continue;
      }
      const set = token === "[" ? bracketSet(pattern, i, spend) : undefined;
      if (set) {
        if (char === "/" || !set.matches(char ?? "")) return false;
        i = set.end;
        continue;
      }
      if (token !== char) return false;
      i++;
    }
    while (pattern[i] === "*") i++;
    return i === pattern.length;
  };

  const matchStar = (star: number, at: number): boolean => {
    let next = star;
    while (pattern[next] === "*") next++;
    let globstar = next - star === 2 && (star === 0 || pattern[star - 1] === "/");
    const separator = path.indexOf("/", at);
    if (next === pattern.length) return globstar || separator < 0;
    if (pattern[next] !== "/") {
      globstar = false;
      if (pattern[next] === "\\") next++;
      if (next === pattern.length) return false;
    }
    if (pattern[next] === "/") {
      if (!globstar) return separator >= 0 && matchFrom(next + 1, separator + 1);
      next++;
      if (next === pattern.length) return false;
    }
    const end = globstar || separator < 0 ? path.length : separator;
    for (let to = at; to < end; to++) {
      if (matchFrom(next, to)) return true;
    }
    return false;
  };

  return match(0, 0);
}

/** The `[...]` at `open`, or undefined when it is a literal `[`: unpaired, empty or with a `/`. */
function bracketSet(
  pattern: string,
  open: number,
  spend: (steps: number) => void,
): { end: number; matches: (char: string) => boolean } | undefined {
  const length = pattern.length;
  const longEnough = open + 3 < length || (open + 3 === length && pattern[open + 1] !== "!");
  if (!longEnough) return undefined;
  let close = open + 1;
  while (close < length && pattern[close] !== "]" && pattern[close] !== "/") close++;
  spend(close - open);
  if (pattern[close] !== "]" || close === open + 1) return undefined;

  const negated = pattern[open + 1] === "!";
  const first = negated ? open + 2 : open + 1;
  const matches = (char: string): boolean => {
    spend(close - first);
    let i = first;
    let found = false;
    do {
      const low = pattern[i] ?? "";
      if (i + 2 < close && pattern[i + 1] === "-") {
        found = low <= char && char <= (pattern[i + 2] ?? "");
        i += 3;
      } else {
        found = char === low;
        i++;
      }
    } while (!found && i < close);
    return found !== negated;
  };
  return { end: close + 1, matches };
}

/**
 * The user's own clang-format: it reads config only and runs no repository code, so this does not
 * depend on repository trust. From the filesystem root, with `{file}` absolute, so a version
 * manager's shim picks nothing from a file the repository has, and off `node_modules/.bin`.
 * Other commands, from manual overrides, keep the defaults.
 */
function clangFormatSpawnOptions(
  command: string,
  _dir: string,
  wtRoot: string,
): FormatterSpawnOptions {
  if (command !== CLANG_FORMAT) return {};
  const PATH = pathOutsideWorktree(buildSpawnEnv().PATH ?? "", resolve(wtRoot))
    .split(delimiter)
    .filter(isAbsolute)
    .join(delimiter);
  return { cwd: "/", env: { PATH }, binDirs: [] };
}

/**
 * A config clang-format cannot use is worth saying, and the client shows the same text once a
 * session. Code with syntax errors does not get here: clang-format formats what it can and exits 0.
 */
function clangFormatFailureNotice(failure: FormatterFailure): string | undefined {
  if (failure.command !== CLANG_FORMAT) return undefined;
  if (failure.kind === "not-installed") {
    return "Format on save skipped: this project uses clang-format, which is not on your PATH. Install it with `brew install clang-format` on a Mac, or your system's package manager elsewhere.";
  }
  const problem = failure.stderr.split("\n").find((line) => CONFIG_ERROR.test(line));
  return problem
    ? `Format on save skipped: clang-format can't use this project's config. ${problem.slice(0, 500)}`
    : undefined;
}
