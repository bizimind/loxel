import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { findFileAbove } from "@/fs-utils";

import { readConfigFile } from "../config-file-read";

/** Includes followed from a repository's config, as deep as git itself follows them. */
const MAX_INCLUDE_DEPTH = 10;

const SECTION_HEADER = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\\n]|\\.)*)")?\s*\]/;
const INCLUDE_PATH = /^\s*path\s*=\s*(.*)$/i;

/**
 * The filter drivers (`[filter "<name>"]`) that the config files of the repository holding `cwd`
 * define, following their includes, conditional ones too: more names than apply only means more
 * overrides. Read as files, so asking runs nothing. The user's own global and system config are not
 * read, since what they define is the user's.
 */
export function repoFilterDrivers(cwd: string): string[] {
  const names = new Set<string>();
  for (const file of repoConfigFiles(path.resolve(cwd))) collectFilterDrivers(file, names, 0);
  return [...names];
}

/** The repository's `config` (in its common dir) and its worktree's `config.worktree`. */
function repoConfigFiles(cwd: string): string[] {
  const gitDir = gitDirOf(cwd);
  if (!gitDir) return [];
  const commonDir = readConfigFile(path.join(gitDir, "commondir"))?.trim();
  const common = commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  return [path.join(common, "config"), path.join(gitDir, "config.worktree")];
}

/** The git dir for `cwd`: a `.git` directory or the one a `.git` file names, or a bare repository. */
function gitDirOf(cwd: string): string | null {
  const dotGit = findFileAbove(".git", cwd);
  if (!dotGit) return existsSync(path.join(cwd, "HEAD")) ? cwd : null;
  try {
    if (lstatSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  const gitdir = /^gitdir: (.+)$/m.exec(readConfigFile(dotGit) ?? "")?.[1]?.trim();
  return gitdir ? path.resolve(path.dirname(dotGit), gitdir) : null;
}

function collectFilterDrivers(file: string, names: Set<string>, depth: number): void {
  const text = readConfigFile(file);
  if (text === undefined || depth > MAX_INCLUDE_DEPTH) return;
  let inInclude = false;
  for (const line of text.split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      const section = header[1]!.toLowerCase();
      const subsection = header[2];
      inInclude = section === "include" || section === "includeif";
      if (section === "filter" && subsection !== undefined) names.add(unescape(subsection));
      // The deprecated `[filter.name]` form, whose name git lower-cases.
      if (section.startsWith("filter.")) names.add(section.slice("filter.".length));
      continue;
    }
    const include = inInclude ? INCLUDE_PATH.exec(line) : null;
    if (include) {
      const target = includePath(include[1]!, file);
      if (target) collectFilterDrivers(target, names, depth + 1);
    }
  }
}

/** An include's `path` value, resolved as git does: `~/` from home, relative from the file's directory. */
function includePath(raw: string, from: string): string | null {
  const value = configValue(raw);
  if (!value) return null;
  if (value === "~" || value.startsWith("~/")) return path.join(homedir(), value.slice(1));
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
