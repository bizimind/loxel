/**
 * Read the 16 ANSI colors of terminal color scheme files, which a Loxel theme can take as its
 * terminal colors: iTerm2 `.itermcolors` (an XML property list), Windows Terminal schemes (one
 * scheme object, an array of them, or a `settings.json` with a `schemes` array) and VS Code color
 * themes or settings (their `terminal.ansi*` colors). Their background, foreground and other
 * colors are not read: a theme's terminal sits on its own surfaces. Everything is read locally; a
 * scheme without all 16 colors is rejected with a message saying which it lacks.
 */
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { isRecord } from "./is-record";
import { ANSI_COLOR_NAMES, type AnsiColorName, type AnsiPalette } from "./loxel-theme";

/** A scheme's name and ANSI colors, read from a file. */
export interface ParsedTerminalScheme {
  name: string;
  ansi: AnsiPalette;
}

/** The schemes a file holds, and why any others in it were left out. */
export interface ParsedSchemeFile {
  schemes: ParsedTerminalScheme[];
  skipped: string[];
}

/** A file that holds no usable scheme. The message is shown to the user as is. */
export class SchemeImportError extends Error {
  override name = "SchemeImportError";
}

/** Scheme files are a few kilobytes; anything far bigger is not one. */
export const MAX_SCHEME_FILE_BYTES = 1024 * 1024;

const MAX_NAME_LENGTH = 80;

/** Reads one scheme of a file; throws `SchemeImportError` when it is incomplete. */
type SchemeReader = () => ParsedTerminalScheme;

/**
 * Parse one scheme file. A file with several schemes keeps the complete ones and lists why the
 * others were skipped; throws `SchemeImportError` when it holds no usable scheme.
 */
export function parseTerminalSchemeFile(fileName: string, text: string): ParsedSchemeFile {
  if (text.length > MAX_SCHEME_FILE_BYTES) {
    throw new SchemeImportError(`${fileName} is too large to be a color scheme.`);
  }
  const readers = schemeReaders(fileName, text);
  const schemes: ParsedTerminalScheme[] = [];
  const skipped: string[] = [];
  for (const read of readers) {
    try {
      schemes.push(read());
    } catch (error) {
      if (!(error instanceof SchemeImportError)) throw error;
      skipped.push(error.message);
    }
  }
  if (schemes.length === 0) throw new SchemeImportError(skipped.join(" "));
  return { schemes, skipped };
}

function schemeReaders(fileName: string, text: string): SchemeReader[] {
  const fallbackName = baseName(fileName);
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) return itermReaders(trimmed, fallbackName, fileName);
  const errors: ParseError[] = [];
  const json: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || json === undefined) {
    throw new SchemeImportError(
      `${fileName} is not an iTerm2 color scheme (.itermcolors) or a JSON color scheme.`,
    );
  }
  return jsonReaders(json, fallbackName, fileName);
}

// ---------------------------------------------------------------------------
// JSON: Windows Terminal and VS Code
// ---------------------------------------------------------------------------

/** VS Code's settings key for color overrides, which `[Theme Name]` keys can scope to a theme. */
const VS_CODE_CUSTOMIZATIONS = "workbench.colorCustomizations";

function jsonReaders(json: unknown, fallbackName: string, fileName: string): SchemeReader[] {
  if (Array.isArray(json)) return windowsTerminalReaders(json, fallbackName, fileName);
  if (!isRecord(json)) throw unrecognized(fileName);
  const { colors, schemes } = json;
  if (isRecord(colors)) {
    if (!hasTerminalColors(colors)) {
      throw new SchemeImportError(`${fileName} is a VS Code theme without terminal colors.`);
    }
    return [() => parseVsCodeColors(schemeName(json.name, fallbackName), colors)];
  }
  const customizations = json[VS_CODE_CUSTOMIZATIONS];
  if (isRecord(customizations))
    return vsCodeSettingsReaders(customizations, fallbackName, fileName);
  if (Array.isArray(schemes)) return windowsTerminalReaders(schemes, fallbackName, fileName);
  if ("background" in json || "foreground" in json || "black" in json) {
    return [() => parseWindowsTerminalScheme(json, fallbackName)];
  }
  throw unrecognized(fileName);
}

function unrecognized(fileName: string): SchemeImportError {
  return new SchemeImportError(
    `${fileName} is not a Windows Terminal color scheme or a VS Code color theme.`,
  );
}

function hasTerminalColors(colors: Record<string, unknown>): boolean {
  return Object.keys(colors).some((key) => key.startsWith("terminal.ansi"));
}

/**
 * A VS Code `settings.json`: terminal colors set for every theme, and per theme under
 * `"[Theme Name]"` keys, each one a scheme named after its theme.
 */
function vsCodeSettingsReaders(
  customizations: Record<string, unknown>,
  fallbackName: string,
  fileName: string,
): SchemeReader[] {
  const readers: SchemeReader[] = [];
  if (hasTerminalColors(customizations)) {
    readers.push(() => parseVsCodeColors(fallbackName, customizations));
  }
  for (const [key, colors] of Object.entries(customizations)) {
    const theme = /^\[(.+)\]$/.exec(key)?.[1];
    // VS Code applies a theme's block over the colors set for every theme.
    if (theme && isRecord(colors) && hasTerminalColors(colors)) {
      readers.push(() =>
        parseVsCodeColors(schemeName(theme, fallbackName), { ...customizations, ...colors }),
      );
    }
  }
  if (readers.length === 0) {
    throw new SchemeImportError(`${fileName} sets no VS Code terminal colors.`);
  }
  return readers;
}

function windowsTerminalReaders(
  schemes: unknown[],
  fallbackName: string,
  fileName: string,
): SchemeReader[] {
  const records = schemes.filter(isRecord);
  if (records.length === 0) throw new SchemeImportError(`${fileName} contains no color schemes.`);
  return records.map(
    (scheme, i) => () =>
      parseWindowsTerminalScheme(
        scheme,
        records.length > 1 ? `${fallbackName} ${i + 1}` : fallbackName,
      ),
  );
}

/** Windows Terminal names magenta "purple". */
function windowsTerminalKey(color: AnsiColorName): string[] {
  if (color === "magenta") return ["purple", "magenta"];
  if (color === "brightMagenta") return ["brightPurple", "brightMagenta"];
  return [color];
}

function parseWindowsTerminalScheme(
  scheme: Record<string, unknown>,
  fallbackName: string,
): ParsedTerminalScheme {
  const name = schemeName(scheme.name, fallbackName);
  const pick = (...keys: string[]) => firstColor(keys.map((k) => scheme[k]));
  const ansi = Object.fromEntries(
    ANSI_COLOR_NAMES.map((color) => [color, pick(...windowsTerminalKey(color))]),
  );
  return completePalette(name, ansi);
}

function parseVsCodeColors(name: string, colors: Record<string, unknown>): ParsedTerminalScheme {
  const ansi = Object.fromEntries(
    ANSI_COLOR_NAMES.map((color) => [
      color,
      firstColor([colors[`terminal.ansi${capitalize(color)}`]]),
    ]),
  );
  return completePalette(name, ansi);
}

// ---------------------------------------------------------------------------
// iTerm2 .itermcolors
// ---------------------------------------------------------------------------

/** iTerm2's per-mode colors, in keys ending in " (Light)" and " (Dark)". */
const ITERM_MODES = [" (Light)", " (Dark)"] as const;
const ITERM_SEPARATE_MODES = "Use Separate Colors for Light and Dark Mode";

/**
 * The scheme, or one per mode when the profile uses separate light and dark colors (or the file
 * has only per-mode colors). With separate colors on, iTerm2 keeps the plain keys too, holding
 * whatever the colors were before the modes were split, so they are ignored then.
 */
function itermReaders(xml: string, fallbackName: string, fileName: string): SchemeReader[] {
  const root = parsePlist(xml, fileName);
  if (!isRecord(root)) throw new SchemeImportError(`${fileName} is not an iTerm2 color scheme.`);
  const has = (suffix: string) => isRecord(root[`Ansi 0 Color${suffix}`]);
  const modes = ITERM_MODES.filter(has);
  const separate = modes.length > 0 && (root[ITERM_SEPARATE_MODES] === true || !has(""));
  const suffixes: readonly string[] = separate ? modes : has("") ? [""] : [];
  if (suffixes.length === 0) {
    throw new SchemeImportError(
      `${fileName} is not an iTerm2 color scheme: it sets no ANSI colors.`,
    );
  }
  return suffixes.map((suffix) => () => {
    const color = (key: string) => itermColor(root[`${key}${suffix}`]);
    const ansi = Object.fromEntries(
      ANSI_COLOR_NAMES.map((name, i) => [name, color(`Ansi ${i} Color`)]),
    );
    return completePalette(`${fallbackName}${suffix}`, ansi);
  });
}

/** Linear Display P3 to linear sRGB (both D65). */
const P3_TO_SRGB: readonly (readonly number[])[] = [
  [1.2249401, -0.2249404, 0],
  [-0.0420569, 1.0420571, 0],
  [-0.0196376, -0.0786361, 1.0982735],
];

/** The sRGB transfer function, which Display P3 shares. */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function p3ToSrgb(rgb: number[]): number[] {
  const linear = rgb.map(toLinear);
  return P3_TO_SRGB.map((row) => {
    const value = row.reduce((sum, weight, i) => sum + weight * (linear[i] ?? 0), 0);
    return fromLinear(Math.min(1, Math.max(0, value)));
  });
}

/**
 * An iTerm2 color dict: `Red/Green/Blue Component` reals from 0 to 1. P3 colors are converted to
 * sRGB, which the terminal draws in (clipping those outside it); sRGB and calibrated (device)
 * colors are taken as sRGB.
 */
function itermColor(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const channels = ["Red", "Green", "Blue"].map((c) => value[`${c} Component`]);
  const rgb = channels.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (rgb.length !== 3) return undefined;
  const srgb = value["Color Space"] === "P3" ? p3ToSrgb(rgb) : rgb;
  return `#${srgb.map((c) => byteHex(c * 255)).join("")}`;
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

/**
 * Read an XML property list with the platform's XML parser: dicts, arrays, strings, numbers and
 * booleans, which is all a color scheme uses. Data and date values read as strings.
 */
function parsePlist(xml: string, fileName: string): PlistValue {
  const fail = (): never => {
    throw new SchemeImportError(`${fileName} is not a valid property list.`);
  };
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) fail();
  const root = doc.documentElement;
  const readValue = (el: Element | null): PlistValue => {
    if (!el) return fail();
    switch (el.tagName) {
      case "dict": {
        const dict: { [key: string]: PlistValue } = {};
        const children = [...el.children];
        for (let i = 0; i < children.length; i += 2) {
          const key = children[i];
          if (key?.tagName !== "key") return fail();
          dict[key.textContent ?? ""] = readValue(children[i + 1] ?? null);
        }
        return dict;
      }
      case "array":
        return [...el.children].map(readValue);
      case "true":
      case "false":
        return el.tagName === "true";
      case "real":
      case "integer":
        return Number(el.textContent);
      case "string":
      case "data":
      case "date":
        return el.textContent ?? "";
      default:
        return fail();
    }
  };
  return readValue(root.tagName === "plist" ? root.firstElementChild : root);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The 16 ANSI colors, or an error naming the ones missing. */
function completePalette(
  name: string,
  colors: Record<string, string | undefined>,
): ParsedTerminalScheme {
  const ansi: Partial<AnsiPalette> = {};
  const missing: string[] = [];
  for (const color of ANSI_COLOR_NAMES) {
    const value = colors[color];
    if (value) ansi[color] = value;
    else missing.push(color);
  }
  if (missing.length > 0) {
    throw new SchemeImportError(`${name} is missing colors: ${missing.join(", ")}.`);
  }
  return { name, ansi: ansi as AnsiPalette };
}

/**
 * The first value that is a hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), as lowercase
 * `#rrggbb`: the terminal draws ANSI colors opaque.
 */
function firstColor(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const digits = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1];
    if (!digits) continue;
    let hex = digits.toLowerCase();
    if (hex.length <= 4) hex = hex.replaceAll(/./g, "$&$&");
    return `#${hex.slice(0, 6)}`;
  }
  return undefined;
}

function schemeName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  return (name || fallback).slice(0, MAX_NAME_LENGTH);
}

function baseName(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).slice(0, MAX_NAME_LENGTH) || "Imported scheme";
}

function byteHex(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
