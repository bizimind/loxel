/**
 * The theme.json format Settings exports and imports, for sharing and backing up themes:
 *
 * ```json
 * {
 *   "loxelTheme": 1,
 *   "name": "Harbor Night",
 *   "base": "dark",
 *   "colors": { "editor-surface": "#0f1a2b", "foreground": "#d4dcea" },
 *   "terminal": { "foreground": "#d4dcea", "red": "#e8676b" },
 *   "syntax": { "keyword": "#5fa8e8", "string": "#8fc77a" }
 * }
 * ```
 *
 * A file holds only what the theme changes; its base (Loxel Light or Loxel Dark) fills in the
 * rest, so a file stays valid as Loxel adds colors. `colors` keys are the UI tokens of
 * `UI_TOKENS`, `terminal` keys the terminal colors (the background is always the editor surface)
 * and `syntax` keys the roles of `SYNTAX_ROLES`.
 */
import { isRecord } from "./is-record";
import {
  isSyntaxRoleId,
  isTerminalColorName,
  isThemeColor,
  isUiTokenName,
  type LoxelTheme,
  MAX_THEME_NAME_LENGTH,
  themeColors,
} from "./loxel-theme";

export const THEME_FILE_VERSION = 1;

/** Theme files are a few kilobytes; anything far bigger is not one. */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

/** A theme read from a file, before it gets an id in the settings. */
export type ParsedTheme = Omit<LoxelTheme, "id">;

export interface ParsedThemeFile {
  theme: ParsedTheme;
  /** What the file sets that this Loxel ignores: unknown names and invalid colors. */
  ignored: string[];
}

/** A file that is not a usable theme. The message is shown to the user as is. */
export class ThemeFileError extends Error {
  override name = "ThemeFileError";
}

/** A theme as theme.json text. */
export function serializeTheme(theme: LoxelTheme): string {
  const file = {
    loxelTheme: THEME_FILE_VERSION,
    name: theme.name,
    base: theme.base,
    colors: theme.colors,
    terminal: theme.terminal,
    syntax: theme.syntax,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A file name for exporting a theme: its name, made safe for file systems. */
export function themeFileName(theme: LoxelTheme): string {
  const base = theme.name.replaceAll(/[^\w .-]+/g, "").trim() || "theme";
  return `${base}.theme.json`;
}

/** Parse a theme.json file. Throws `ThemeFileError` when it is not a usable theme. */
export function parseThemeFile(fileName: string, text: string): ParsedThemeFile {
  if (text.length > MAX_THEME_FILE_BYTES) {
    throw new ThemeFileError(`${fileName} is too large to be a Loxel theme.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ThemeFileError(`${fileName} is not a Loxel theme: it is not valid JSON.`);
  }
  if (!isRecord(json) || !("loxelTheme" in json)) {
    throw new ThemeFileError(`${fileName} is not a Loxel theme (theme.json).`);
  }
  if (json.loxelTheme !== THEME_FILE_VERSION) {
    throw new ThemeFileError(
      `${fileName} is a Loxel theme of a version this Loxel does not read; update Loxel to import it.`,
    );
  }
  const { base } = json;
  if (base !== "light" && base !== "dark") {
    throw new ThemeFileError(`${fileName} has no "base" of "light" or "dark".`);
  }
  const rawName = typeof json.name === "string" ? json.name.trim() : "";
  const name = (rawName || fileName.replace(/(\.theme)?\.json$/i, "")).slice(
    0,
    MAX_THEME_NAME_LENGTH,
  );
  return {
    theme: { name, base, ...themeColors(json) },
    ignored: [
      ...ignoredEntries(json.colors, "colors", isUiTokenName),
      ...ignoredEntries(json.terminal, "terminal", isTerminalColorName),
      ...ignoredEntries(json.syntax, "syntax", isSyntaxRoleId),
    ],
  };
}

function ignoredEntries(value: unknown, field: string, isKey: (key: string) => boolean): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [field];
  return Object.entries(value)
    .filter(([key, color]) => !isKey(key) || !isThemeColor(color))
    .map(([key]) => `${field}.${key}`);
}
