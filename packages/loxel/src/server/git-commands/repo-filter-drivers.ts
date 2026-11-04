import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Includes followed from a repository's config, as deep as git itself follows them. */
const MAX_INCLUDE_DEPTH = 10;
/**
 * What one scan may read in all, since it runs on the main thread before every read: far above any
 * real config, and past it the answer is "unknown" rather than "none".
 */
const SCAN_BUDGET = { bytes: 8 * 1024 * 1024, files: 256 } as const;

/**
 * Filter section headers, found anywhere in the text rather than at line starts, since git takes a
 * header after another one or after a key on the same line: `[filter "name"]`, `[filter.base
 * "sub"]` (driver `base.sub`, the base lower-cased), and the deprecated `[filter.name]`, whose name
 * git lower-cases. Dotted segments may be empty, as git allows. One quantifier per part keeps the
 * match linear. Matching inside a value too only adds names.
 */
const FILTER_HEADER = /\[\s*filter(?:(\.[^\]\s"]*)?\s+"((?:[^"\\\n]|\\.)*)"|\.([^\]\s"]*))\s*\]/gi;
/** `path` keys anywhere, taken as includes whatever their section: a spare file read adds names only. */
const PATH_KEY = /(?:^|[\s\]])path\s*=([^\n]*)/gim;

/**
 * The filter drivers (`[filter "<name>"]`) that the config files of the repository holding `cwd`
 * define, following their includes, conditional ones too. It over-reads rather than parse as git
 * does: more names than apply only means more overrides. Read as files, so asking runs nothing.
 * The user's own global and system config are not read, since what they define is the user's.
 * Null when the names are unknown: a file that decides them could not be read in full, or a name
 * is not text an environment variable can carry, so it could not be turned off.
 */
export function repoFilterDrivers(cwd: string): string[] | null {
  const files = repoConfigFiles(utf8ToBytes(path.resolve(cwd)));
  if (files === null) return null;
  const scan: Scan = { names: new Set(), visited: new Set(), budget: { ...SCAN_BUDGET } };
  for (const file of files) {
    if (!collectFilterDrivers(file, scan, 0)) return null;
  }
  const { names } = scan;
  const decoded: string[] = [];
  for (const name of names) {
    try {
      decoded.push(UTF8.decode(Buffer.from(name, "latin1")));
    } catch {
      return null;
    }
  }
  return decoded;
}

// Git reads config as bytes, so paths and text here are byte strings, one character per byte
// (latin1), and go back to bytes for the filesystem: a name or include path that is not UTF-8 is
// read as git reads it.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function utf8ToBytes(text: string): string {
  return Buffer.from(text, "utf8").toString("latin1");
}

function fsPath(bytes: string): Buffer {
  return Buffer.from(bytes, "latin1");
}

interface Budget {
  bytes: number;
  files: number;
}

interface Scan {
  names: Set<string>;
  visited: Set<string>;
  budget: Budget;
}

/**
 * A file's bytes, counted against `budget`; undefined when there is none to read, null when it
 * could not be read in full or would exceed the budget.
 */
function readRepoFile(file: string, budget: Budget): string | undefined | null {
  try {
    const info = statSync(fsPath(file));
    // Git cannot read anything but a file either.
    if (!info.isFile()) return undefined;
    budget.files -= 1;
    budget.bytes -= info.size;
    if (budget.files < 0 || budget.bytes < 0) return null;
    return readFileSync(fsPath(file)).toString("latin1");
  } catch (err) {
    return isNotFound(err) ? undefined : null;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/**
 * The repository's `config` (in its common dir) and its worktree's `config.worktree`; null when a
 * file that says where they are could not be read in full.
 */
function repoConfigFiles(cwd: string): string[] | null {
  // Small files that only point elsewhere; their own budget keeps them out of the scan's.
  const budget: Budget = { ...SCAN_BUDGET };
  const gitDir = gitDirOf(cwd, budget);
  if (gitDir === null) return null;
  if (gitDir === undefined) return [];
  const commonDir = readRepoFile(path.join(gitDir, "commondir"), budget);
  if (commonDir === null) return null;
  const relative = commonDir?.trim();
  const common = relative ? path.resolve(gitDir, relative) : gitDir;
  return [path.join(common, "config"), path.join(gitDir, "config.worktree")];
}

/**
 * The git dir for `cwd`: a `.git` directory (a symlink to one too, as git follows it) or the one a
 * `.git` file names, or a bare repository; undefined outside any, null when a `.git` file could
 * not be read in full.
 */
function gitDirOf(cwd: string, budget: Budget): string | undefined | null {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let isDirectory: boolean;
    try {
      isDirectory = statSync(fsPath(dotGit)).isDirectory();
    } catch {
      if (path.dirname(dir) === dir) break;
      continue;
    }
    if (isDirectory) return dotGit;
    const pointer = readRepoFile(dotGit, budget);
    if (pointer === null) return null;
    const gitdir = /^gitdir: (.+)$/m.exec(pointer ?? "")?.[1]?.trim();
    return gitdir ? path.resolve(dir, gitdir) : undefined;
  }
  return existsSync(fsPath(path.join(cwd, "HEAD"))) ? cwd : undefined;
}

/** Adds `file`'s drivers and its includes' to `names`; false when one could not be read. */
function collectFilterDrivers(file: string, scan: Scan, depth: number): boolean {
  const { names, visited } = scan;
  if (depth > MAX_INCLUDE_DEPTH || visited.has(file)) return true;
  visited.add(file);
  const raw = readRepoFile(file, scan.budget);
  if (raw === null) return false;
  if (raw === undefined) return true;
  // A backslash at the end of a line continues the line, inside a header's name too.
  const text = raw.replace(/\\\r?\n/g, "");
  for (const [, base, quoted, legacy] of text.matchAll(FILTER_HEADER)) {
    if (quoted === undefined) {
      names.add(legacy!.toLowerCase());
    } else {
      const prefix = base ? `${base.slice(1).toLowerCase()}.` : "";
      names.add(`${prefix}${unescape(quoted)}`);
    }
  }
  for (const [, value] of text.matchAll(PATH_KEY)) {
    const target = includePath(value!, file);
    if (target && !collectFilterDrivers(target, scan, depth + 1)) return false;
  }
  return true;
}

/** An include's `path` value, resolved as git does: `~/` from home, relative from the file's directory. */
function includePath(raw: string, from: string): string | null {
  const value = configValue(raw);
  if (!value) return null;
  if (value === "~" || value.startsWith("~/")) {
    return path.join(utf8ToBytes(homedir()), value.slice(1));
  }
  return path.resolve(path.dirname(from), value);
}

/** A config value without its comment and quotes. */
function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === "\\" && i + 1 < raw.length) {
      value += raw[++i];
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      value += char;
    }
  }
  return value.trim();
}

/** A subsection name as git reads it: a backslash keeps the character after it. */
function unescape(subsection: string): string {
  return subsection.replace(/\\(.)/g, "$1");
}
