import { stat } from "node:fs/promises";
import { dirname, relative } from "node:path";

import type { EditorConfigProperties } from "@/api/editorconfig-model";

import { type SectionGlob, compileSectionGlob, globMatches } from "./editorconfig-glob";
import { logger } from "./logger";

const log = logger.child("files");

/**
 * EditorConfig (https://spec.editorconfig.org) resolution. A file's properties come from every
 * `.editorconfig` between its directory and the tree root, stopping early at one with
 * `root = true`. Files are applied from the outermost in, and sections in file order, so the
 * nearest file's last matching section wins each property.
 */

const FILE_NAME = ".editorconfig";
/** The spec limits section names to 1024 characters; a longer one is ignored with its keys. */
const MAX_SECTION_LINE = 1026;
/**
 * Real files are a few KB. Bounding the size bounds the section count, and with it (see
 * editorconfig-glob.ts) the time a crafted file in a cloned repository can take per lookup.
 */
const MAX_FILE_SIZE = 64 * 1024;

interface Section {
  glob: SectionGlob;
  properties: Array<[key: string, value: string]>;
}

export interface EditorConfigFile {
  root: boolean;
  sections: Section[];
}

/** Parse one `.editorconfig` file. Keys are lowercased; values are kept as written. */
export function parseEditorConfig(text: string): EditorConfigFile {
  let root = false;
  const sections: Section[] = [];
  // null in the preamble; "invalid" after a malformed section header, whose keys are skipped.
  let current: Section | "invalid" | null = null;
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      if (!line.endsWith("]") || line.length === 2 || line.length > MAX_SECTION_LINE) {
        current = "invalid";
        continue;
      }
      current = { glob: compileSectionGlob(line.slice(1, -1)), properties: [] };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (current === null) {
      if (key === "root") root = value.toLowerCase() === "true";
    } else if (current !== "invalid") {
      current.properties.push([key, value]);
    }
  }
  return { root, sections };
}

const configCache = new Map<string, { mtimeMs: number; size: number; config: EditorConfigFile }>();

/**
 * Resolve the properties for `filePath`, a path inside `rootDir` (the worktree or Others folder
 * it belongs to); the file itself need not exist. Parsed files are cached and re-read when their
 * modification time or size changes, so the result is current whether or not a watcher covers
 * the tree.
 */
export async function resolveEditorConfig(
  filePath: string,
  rootDir: string,
): Promise<EditorConfigProperties> {
  if (!filePath.startsWith(rootDir + "/")) return {};
  // Nearest directory first, up to and including the root.
  const chain: Array<{ dir: string; config: EditorConfigFile }> = [];
  for (let dir = dirname(filePath); ; dir = dirname(dir)) {
    const config = await loadConfig(`${dir}/${FILE_NAME}`);
    if (config) chain.push({ dir, config });
    if (config?.root || dir === rootDir || dir === dirname(dir)) break;
  }

  const raw = new Map<string, string>();
  for (const { dir, config } of chain.reverse()) {
    const relativePath = relative(dir, filePath);
    for (const section of config.sections) {
      if (!globMatches(section.glob, relativePath)) continue;
      for (const [key, value] of section.properties) raw.set(key, value);
    }
  }
  return toProperties(raw);
}

async function loadConfig(path: string): Promise<EditorConfigFile | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    configCache.delete(path);
    if (!isNotFound(err)) log.debug("Could not stat .editorconfig", { path, error: err });
    return null;
  }
  if (!info.isFile()) {
    configCache.delete(path);
    return null;
  }
  if (info.size > MAX_FILE_SIZE) {
    configCache.delete(path);
    log.warn("Ignoring oversized .editorconfig", { path, size: info.size });
    return null;
  }
  const cached = configCache.get(path);
  if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.config;
  try {
    const config = parseEditorConfig(await Bun.file(path).text());
    configCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, config });
    return config;
  } catch (err) {
    configCache.delete(path);
    log.warn("Could not read .editorconfig", { path, error: err });
    return null;
  }
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return err.code === "ENOENT" || err.code === "ENOTDIR";
}

/** Map raw key/value pairs to the properties Loxel applies, defaulting them as the spec says. */
function toProperties(raw: ReadonlyMap<string, string>): EditorConfigProperties {
  // Every value Loxel reads is a single token; ignoring the rest tolerates trailing comments.
  const value = (key: string): string | undefined => {
    const v = raw.get(key)?.split(/\s/, 1)[0]?.toLowerCase();
    return v === "unset" ? undefined : v;
  };
  const properties: EditorConfigProperties = {};

  const indentStyle = value("indent_style");
  if (indentStyle === "space" || indentStyle === "tab") properties.indentStyle = indentStyle;

  const tabWidth = positiveInt(value("tab_width"));
  const rawIndentSize = value("indent_size");
  // `indent_size = tab`, and `indent_style = tab` without an indent_size, both mean "a tab's width".
  const indentSize =
    rawIndentSize === "tab" || (rawIndentSize === undefined && indentStyle === "tab")
      ? tabWidth
      : positiveInt(rawIndentSize);
  if (indentSize !== undefined) properties.indentSize = indentSize;
  const effectiveTabWidth = tabWidth ?? indentSize;
  if (effectiveTabWidth !== undefined) properties.tabWidth = effectiveTabWidth;

  const endOfLine = value("end_of_line");
  if (endOfLine === "lf" || endOfLine === "crlf") properties.endOfLine = endOfLine;

  const insertFinalNewline = bool(value("insert_final_newline"));
  if (insertFinalNewline !== undefined) properties.insertFinalNewline = insertFinalNewline;
  const trimTrailingWhitespace = bool(value("trim_trailing_whitespace"));
  if (trimTrailingWhitespace !== undefined) {
    properties.trimTrailingWhitespace = trimTrailingWhitespace;
  }
  return properties;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
