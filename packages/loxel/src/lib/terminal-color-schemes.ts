/**
 * Terminal color schemes: the ANSI palette, foreground, background, cursor and selection colors a
 * terminal draws with. Settings pick one scheme for the light theme and one for the dark theme,
 * from Loxel's built-in schemes or ones the user imported from a file (see
 * `terminal-scheme-import.ts`). Imported schemes are stored in the settings themselves.
 */
import { isRecord } from "./is-record";

/** The 16 ANSI colors, in SGR order (30–37, then 90–97), named as xterm.js names them. */
export const ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];

/** Every color a scheme sets. Values are CSS colors xterm.js accepts (`#rrggbb`, `#rrggbbaa`, `rgba()`). */
export type TerminalPalette = Record<AnsiColorName, string> & {
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
};

export interface TerminalColorScheme {
  id: string;
  name: string;
  palette: TerminalPalette;
}

/** Which scheme each theme uses, and the schemes the user imported. */
export interface TerminalColorSchemeSettings {
  light: string;
  dark: string;
  imported: TerminalColorScheme[];
}

/** Which of the two themes a scheme choice applies to. */
export type TerminalSchemeTheme = Exclude<keyof TerminalColorSchemeSettings, "imported">;

export const LOXEL_LIGHT_SCHEME_ID = "loxel-light";
export const LOXEL_DARK_SCHEME_ID = "loxel-dark";

/**
 * Loxel Light. Normal colors are deep (7-9:1 on white); bright colors are vivid and light, so as
 * backgrounds they carry black text and as text the minimum contrast below darkens them to 4.5:1,
 * which keeps each one lighter than its normal color. Bright black is a dark grey; white a light
 * grey and bright white an off-white, both still visible as swatches. The background is the light
 * theme's editor surface.
 */
const LOXEL_LIGHT: TerminalColorScheme = {
  id: LOXEL_LIGHT_SCHEME_ID,
  name: "Loxel Light",
  palette: {
    foreground: "#1e1f22",
    background: "#ffffff",
    cursor: "#1e1f22",
    selection: "rgba(53, 116, 240, 0.22)",
    black: "#1e1f22",
    red: "#a31621",
    green: "#0e5a26",
    yellow: "#7f4300",
    blue: "#06449a",
    magenta: "#7e2a98",
    cyan: "#08525a",
    white: "#b6bac2",
    brightBlack: "#40444d",
    brightRed: "#f2453d",
    brightGreen: "#1cc24f",
    brightYellow: "#f5a623",
    brightBlue: "#4a8cff",
    brightMagenta: "#b56cff",
    brightCyan: "#2bb5e0",
    brightWhite: "#e6e8ec",
  },
};

/**
 * Loxel Dark: the Darcula console palette JetBrains' New UI Dark inherits, on the dark theme's
 * editor surface.
 */
const LOXEL_DARK: TerminalColorScheme = {
  id: LOXEL_DARK_SCHEME_ID,
  name: "Loxel Dark",
  palette: {
    foreground: "#a9b7c6",
    background: "#131313",
    cursor: "#ced0d6",
    selection: "rgba(255, 255, 255, 0.18)",
    black: "#000000",
    red: "#ff6b68",
    green: "#a8c023",
    yellow: "#d6bf55",
    blue: "#5394ec",
    magenta: "#ae8abe",
    cyan: "#299999",
    white: "#999999",
    brightBlack: "#555555",
    brightRed: "#ff8785",
    brightGreen: "#a8c023",
    brightYellow: "#d6bf55",
    brightBlue: "#7eaef1",
    brightMagenta: "#ff99ff",
    brightCyan: "#6cdada",
    brightWhite: "#ffffff",
  },
};

export const BUILTIN_TERMINAL_COLOR_SCHEMES: readonly TerminalColorScheme[] = [
  LOXEL_LIGHT,
  LOXEL_DARK,
];

export const DEFAULT_TERMINAL_COLOR_SCHEMES: TerminalColorSchemeSettings = {
  light: LOXEL_LIGHT_SCHEME_ID,
  dark: LOXEL_DARK_SCHEME_ID,
  imported: [],
};

/**
 * xterm.js `minimumContrastRatio` per built-in scheme. Loxel Light raises it so colors meant for
 * dark backgrounds (white, bright white, dim) stay readable on white; vite.config.ts patches the
 * WebGL renderer so dim text meets it as drawn too. Imported schemes are drawn as their files set
 * them.
 */
const MINIMUM_CONTRAST: Partial<Record<string, number>> = { [LOXEL_LIGHT_SCHEME_ID]: 4.5 };

const PALETTE_KEYS = [
  ...ANSI_COLOR_NAMES,
  "foreground",
  "background",
  "cursor",
  "selection",
] as const satisfies readonly (keyof TerminalPalette)[];

function isStoredScheme(value: unknown): value is TerminalColorScheme {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return false;
  }
  const { palette } = value;
  return isRecord(palette) && PALETTE_KEYS.every((key) => typeof palette[key] === "string");
}

/**
 * Stored or synced color scheme settings, checked: a missing or malformed field takes its default
 * and an imported scheme without a complete palette is dropped. Valid settings come back as the
 * same object, so a synced update that leaves them alone does not recolor terminals.
 */
export function parseTerminalColorSchemeSettings(value: unknown): TerminalColorSchemeSettings {
  const settings = isRecord(value) ? value : {};
  const { light, dark, imported } = settings;
  const importedValid = Array.isArray(imported) && imported.every(isStoredScheme);
  if (typeof light === "string" && typeof dark === "string" && importedValid) {
    // Every field was just checked.
    return settings as unknown as TerminalColorSchemeSettings;
  }
  return {
    light: typeof light === "string" ? light : DEFAULT_TERMINAL_COLOR_SCHEMES.light,
    dark: typeof dark === "string" ? dark : DEFAULT_TERMINAL_COLOR_SCHEMES.dark,
    imported: Array.isArray(imported) ? imported.filter(isStoredScheme) : [],
  };
}

/**
 * The scheme a theme uses. A choice that names no scheme (an imported one since removed, or a
 * hand-edited setting) falls back to the theme's built-in default.
 */
export function resolveTerminalColorScheme(
  settings: TerminalColorSchemeSettings,
  dark: boolean,
): TerminalColorScheme {
  const id = dark ? settings.dark : settings.light;
  const found =
    BUILTIN_TERMINAL_COLOR_SCHEMES.find((s) => s.id === id) ??
    settings.imported.find((s) => s.id === id);
  return found ?? (dark ? LOXEL_DARK : LOXEL_LIGHT);
}

/** xterm.js `theme` and `minimumContrastRatio` options for a scheme. */
export function xtermColorOptions(scheme: TerminalColorScheme) {
  const { foreground, background, cursor, selection, ...ansi } = scheme.palette;
  return {
    theme: {
      ...ansi,
      foreground,
      background,
      cursor,
      cursorAccent: background,
      selectionBackground: selection,
    },
    minimumContrastRatio: MINIMUM_CONTRAST[scheme.id] ?? 1,
  };
}
