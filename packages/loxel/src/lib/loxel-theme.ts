/**
 * Loxel color themes. A theme is one appearance, built on Loxel Light or Loxel Dark (its `base`),
 * and overrides only what it changes: UI color tokens (the CSS custom properties in index.css),
 * terminal colors and syntax colors by role. Settings pick one theme for light mode and one for
 * dark mode; custom themes live in the settings, and travel as theme.json files (theme-file.ts).
 *
 * The terminal background is never part of a theme: it is the theme's editor surface, so a
 * terminal always sits on the surface around it.
 */
import { isRecord } from "./is-record";

export type ThemeBase = "light" | "dark";

// ---------------------------------------------------------------------------
// UI color tokens
// ---------------------------------------------------------------------------

export const UI_TOKEN_GROUPS = [
  "Surfaces",
  "Text",
  "Accent and controls",
  "Editor",
  "Git",
  "Diff",
  "Comments",
] as const;
export type UiTokenGroup = (typeof UI_TOKEN_GROUPS)[number];

export interface UiToken {
  /** The CSS custom property without its leading `--`. */
  name: string;
  label: string;
  group: UiTokenGroup;
  /** Only the light base draws it; dark themes do not offer it. */
  lightOnly?: boolean;
}

const token = (name: string, label: string, group: UiTokenGroup, lightOnly?: boolean): UiToken =>
  lightOnly ? { name, label, group, lightOnly } : { name, label, group };

/**
 * The color tokens a theme can set, from index.css. Lengths and shadows (`--radius`,
 * `--shadow-*`, `--text-shadow`) are not colors and stay Loxel's.
 */
export const UI_TOKENS: readonly UiToken[] = [
  token("background", "Window background", "Surfaces"),
  token("editor-surface", "Editor and terminal", "Surfaces"),
  token("surface-0", "Elevated (hovers, buttons on cards)", "Surfaces"),
  token("surface-1", "Panels, cards and popups", "Surfaces"),
  token("surface-2", "Inputs", "Surfaces"),
  token("surface-3", "Surface borders", "Surfaces"),
  token("surface-muted", "Unfocused title bar", "Surfaces"),
  token("card", "Sidebars, tool, title and status bars", "Surfaces"),
  token("popover", "Menus and popovers", "Surfaces"),
  token("muted", "Muted fill", "Surfaces"),
  token("secondary", "Secondary fill", "Surfaces"),
  token("foreground", "Text", "Text"),
  token("muted-foreground", "Secondary text", "Text"),
  token("card-foreground", "Text on bars", "Text"),
  token("popover-foreground", "Text in menus", "Text"),
  token("secondary-foreground", "Text on secondary fill", "Text"),
  token("primary", "Selection fill", "Accent and controls"),
  token("primary-foreground", "Text on selection", "Accent and controls"),
  token("accent", "Selected segment", "Accent and controls"),
  token("accent-foreground", "Text on selected segment", "Accent and controls"),
  token("nav-active", "Settings section in view", "Accent and controls"),
  token("link", "Links and accent text", "Accent and controls"),
  token("button-primary", "Primary buttons and switches", "Accent and controls"),
  token("button-primary-foreground", "Text on primary buttons", "Accent and controls"),
  token("ring", "Focus ring", "Accent and controls"),
  token("border", "Borders", "Accent and controls"),
  token("input", "Input borders", "Accent and controls"),
  token("scrollbar-thumb", "Scrollbar thumb", "Accent and controls"),
  token("scrollbar-track", "Scrollbar track", "Accent and controls"),
  token("destructive", "Errors and destructive actions", "Accent and controls"),
  token("warning", "Warnings", "Accent and controls"),
  token("editor-line-number", "Line numbers", "Editor"),
  token("editor-line-number-active", "Current line number", "Editor"),
  token("tree-folder", "Folders in file trees", "Editor"),
  token("vcs-modified", "Modified files", "Git", true),
  token("vcs-untracked", "Untracked files", "Git", true),
  token("ref-head", "HEAD ref", "Git"),
  token("ref-local", "Local branch ref", "Git"),
  token("ref-remote", "Remote branch ref", "Git"),
  token("ref-tag", "Tag ref", "Git"),
  token("ref-head-bg", "HEAD ref fill", "Git", true),
  token("ref-local-bg", "Local branch ref fill", "Git", true),
  token("ref-remote-bg", "Remote branch ref fill", "Git", true),
  token("ref-tag-bg", "Tag ref fill", "Git", true),
  ...[1, 2, 3, 4, 5, 6].map((n) => token(`branch-${n}`, `Graph branch ${n}`, "Git")),
  token("diff-add-bg", "Added line", "Diff"),
  token("diff-add-inline-bg", "Added text", "Diff"),
  token("diff-add-gutter", "Added gutter", "Diff"),
  token("diff-add-text", "Added count", "Diff"),
  token("diff-add-connector-fill", "Added connector fill", "Diff", true),
  token("diff-add-connector-edge", "Added connector edge", "Diff", true),
  token("diff-del-bg", "Deleted line", "Diff"),
  token("diff-del-inline-bg", "Deleted text", "Diff"),
  token("diff-del-gutter", "Deleted gutter", "Diff"),
  token("diff-del-text", "Deleted count", "Diff"),
  token("diff-del-connector-fill", "Deleted connector fill", "Diff", true),
  token("diff-del-connector-edge", "Deleted connector edge", "Diff", true),
  token("diff-modify-bg", "Modified line", "Diff"),
  token("diff-modify-gutter", "Modified gutter", "Diff"),
  token("diff-modify-text", "Modified count", "Diff"),
  token("diff-gutter-border", "Gutter edges", "Diff"),
  token("diff-collapse-line", "Collapsed lines", "Diff"),
  token("diff-collapse-line-hover", "Collapsed lines, hovered", "Diff"),
  token("comment-bg", "Commented code", "Comments"),
  token("comment-bg-resolved", "Resolved commented code", "Comments"),
  token("comment-marker", "Comment marker", "Comments"),
  token("comment-edge", "Commented line edge", "Comments", true),
  token("comment-stripe", "Comment stripe", "Comments"),
  token("comment-stripe-resolved", "Resolved comment stripe", "Comments"),
];

const UI_TOKEN_NAMES = new Set(UI_TOKENS.map((t) => t.name));

/** The tokens a theme on `base` can set. */
export function uiTokensFor(base: ThemeBase): UiToken[] {
  return UI_TOKENS.filter((t) => base === "light" || !t.lightOnly);
}

// ---------------------------------------------------------------------------
// Terminal colors
// ---------------------------------------------------------------------------

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
export type AnsiPalette = Record<AnsiColorName, string>;

/** The terminal colors a theme sets; the background is the theme's editor surface. */
export const TERMINAL_COLOR_NAMES = [
  "foreground",
  "cursor",
  "selection",
  ...ANSI_COLOR_NAMES,
] as const;
export type TerminalColorName = (typeof TERMINAL_COLOR_NAMES)[number];
export type TerminalColors = Record<TerminalColorName, string>;

// ---------------------------------------------------------------------------
// Syntax roles
// ---------------------------------------------------------------------------

export interface SyntaxRole {
  id: string;
  label: string;
  /**
   * The TextMate scopes the role colors; the first one's color in the base theme is the role's
   * default. No scopes: the default text color.
   */
  scopes: readonly string[];
  /** Language-server semantic token types the role colors in the editors. */
  semantic: readonly string[];
}

const role = (
  id: string,
  label: string,
  scopes: readonly string[],
  semantic: readonly string[] = [],
): SyntaxRole => ({ id, label, scopes, semantic });

/**
 * Syntax colors a theme can set, each a group of TextMate scopes (and semantic token types) the
 * Loxel themes color alike. A role's color applies to all of them, over the base theme's rules.
 */
export const SYNTAX_ROLES: readonly SyntaxRole[] = [
  role("text", "Text and variables", [], ["variable", "parameter", "variable.readonly.local"]),
  role("comment", "Comments", [
    "comment",
    "punctuation.definition.comment",
    "comment.block.documentation",
  ]),
  role(
    "keyword",
    "Keywords",
    [
      "keyword",
      "storage.type",
      "storage.modifier",
      "keyword.control.import",
      "keyword.control.export",
      "keyword.control.from",
      "keyword.operator.new",
      "keyword.operator.expression",
      "keyword.operator.expression.instanceof.tsx",
    ],
    ["keyword"],
  ),
  role("operator", "Operators", ["keyword.operator"]),
  role("string", "Strings", [
    "string",
    "punctuation.definition.string",
    "string.quoted.double.html",
  ]),
  role("escape", "Escapes and template expressions", [
    "constant.character.escape",
    "punctuation.definition.template-expression.begin.tsx",
    "punctuation.definition.template-expression.end.tsx",
  ]),
  role("regexp", "Regular expressions", [
    "string.regexp",
    "source.regexp",
    "constant.other.character-class.regexp",
    "constant.other.character-class.set.regexp",
    "keyword.operator.quantifier.regexp",
    "keyword.operator.negation.regexp",
  ]),
  role(
    "constant",
    "Numbers and constants",
    [
      "constant.numeric",
      "constant",
      "constant.language",
      "constant.other",
      "variable.other.enummember",
    ],
    ["enumMember"],
  ),
  role(
    "type",
    "Types",
    [
      "entity.name.type",
      "support.type",
      "support.class",
      "meta.objectliteral.tsx",
      "entity.name.type.enum",
      "entity.name.type.parameter",
      "entity.name.namespace",
      "entity.name.module",
    ],
    ["type", "class", "interface", "enum", "namespace", "typeParameter"],
  ),
  role(
    "function",
    "Functions",
    ["entity.name.function", "support.function", "support.class.component"],
    ["function", "method", "member"],
  ),
  role(
    "property",
    "Properties",
    [
      "variable.other.property",
      "variable.other.object.property",
      "support.variable",
      "meta.object-literal.key",
      "entity.name.tag.yaml",
    ],
    ["property", "variable.readonly"],
  ),
  role(
    "self",
    "this, self and cls",
    [
      "variable.language",
      "variable.language.special.self.python",
      "variable.parameter.function.language.special.self.python",
      "variable.language.special.cls.python",
      "variable.parameter.function.language.special.cls.python",
    ],
    ["selfParameter", "clsParameter"],
  ),
  role(
    "decorator",
    "Decorators and annotations",
    ["meta.decorator", "entity.name.function.decorator", "storage.type.annotation"],
    ["decorator"],
  ),
  role(
    "tag",
    "Markup tags",
    [
      "entity.name.tag",
      "punctuation.definition.tag",
      "punctuation.definition.tag.begin",
      "punctuation.definition.tag.end",
    ],
    ["delimiter.html"],
  ),
  role("attribute", "Markup attributes", ["entity.other.attribute-name"]),
  role("punctuation", "Punctuation", [
    "punctuation.separator",
    "punctuation.terminator",
    "meta.brace",
    "punctuation.section",
  ]),
  role("heading", "Markdown headings", ["markup.heading", "markup.heading entity.name"]),
  role("inlineCode", "Markdown inline code", ["markup.inline.raw"]),
  role("link", "Markdown links", ["markup.underline.link"]),
];

const SYNTAX_ROLE_IDS = new Set(SYNTAX_ROLES.map((r) => r.id));

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export interface LoxelTheme {
  id: string;
  name: string;
  base: ThemeBase;
  /** UI token overrides, by token name without the leading `--`. */
  colors: Record<string, string>;
  /** Terminal color overrides; the base theme's colors fill in the rest. */
  terminal: Partial<TerminalColors>;
  /** Syntax color overrides, by role id. */
  syntax: Record<string, string>;
}

/** Which theme each mode uses, and the user's own themes. */
export interface ThemeSettings {
  light: string;
  dark: string;
  custom: LoxelTheme[];
}

/** The longest theme name Settings and theme.json keep. */
export const MAX_THEME_NAME_LENGTH = 80;

export const LOXEL_LIGHT_THEME_ID = "loxel-light";
export const LOXEL_DARK_THEME_ID = "loxel-dark";

/**
 * Loxel Light's terminal. Normal colors are deep (7-9:1 on white); bright colors are vivid and
 * light, so as backgrounds they carry black text and as text the minimum contrast darkens them to
 * 4.5:1, which keeps each one lighter than its normal color. Bright black is a dark grey; white a
 * light grey and bright white an off-white, both still visible as swatches.
 */
const LOXEL_LIGHT_TERMINAL: TerminalColors = {
  foreground: "#1e1f22",
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
};

/** Loxel Dark's terminal: the Darcula console palette JetBrains' New UI Dark inherits. */
const LOXEL_DARK_TERMINAL: TerminalColors = {
  foreground: "#a9b7c6",
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
};

const BASE_TERMINAL: Record<ThemeBase, TerminalColors> = {
  light: LOXEL_LIGHT_TERMINAL,
  dark: LOXEL_DARK_TERMINAL,
};

const LOXEL_LIGHT: LoxelTheme = {
  id: LOXEL_LIGHT_THEME_ID,
  name: "Loxel Light",
  base: "light",
  colors: {},
  terminal: {},
  syntax: {},
};

const LOXEL_DARK: LoxelTheme = {
  id: LOXEL_DARK_THEME_ID,
  name: "Loxel Dark",
  base: "dark",
  colors: {},
  terminal: {},
  syntax: {},
};

export const BUILTIN_THEMES: readonly LoxelTheme[] = [LOXEL_LIGHT, LOXEL_DARK];

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  light: LOXEL_LIGHT_THEME_ID,
  dark: LOXEL_DARK_THEME_ID,
  custom: [],
};

export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_THEMES.some((t) => t.id === id);
}

/** Built-in themes first, then the user's, in the order they were added. */
export function allThemes(settings: ThemeSettings): LoxelTheme[] {
  return [...BUILTIN_THEMES, ...settings.custom];
}

/**
 * The theme a mode uses. A choice that names no theme of that mode's base (one since removed, or
 * a hand-edited setting) falls back to the mode's built-in.
 */
export function resolveTheme(settings: ThemeSettings, dark: boolean): LoxelTheme {
  const base: ThemeBase = dark ? "dark" : "light";
  const id = dark ? settings.dark : settings.light;
  const found = allThemes(settings).find((t) => t.id === id && t.base === base);
  return found ?? (dark ? LOXEL_DARK : LOXEL_LIGHT);
}

/** A theme's terminal colors, its overrides over its base's. */
export function terminalColors(theme: LoxelTheme): TerminalColors {
  return { ...BASE_TERMINAL[theme.base], ...theme.terminal };
}

/**
 * xterm.js `minimumContrastRatio` per base. The light base raises it so colors meant for dark
 * backgrounds (white, bright white, dim) stay readable on a light surface; vite.config.ts patches
 * the WebGL renderer so dim text meets it as drawn too.
 */
const MINIMUM_CONTRAST: Record<ThemeBase, number> = { light: 4.5, dark: 1 };

/** xterm.js `theme` and `minimumContrastRatio` options for a theme, on its editor surface. */
export function xtermColorOptions(theme: LoxelTheme, background: string) {
  const { foreground, cursor, selection, ...ansi } = terminalColors(theme);
  return {
    theme: {
      ...ansi,
      foreground,
      background,
      cursor,
      cursorAccent: background,
      selectionBackground: selection,
    },
    minimumContrastRatio: MINIMUM_CONTRAST[theme.base],
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const FUNCTION_COLOR = /^(?:rgba?|hsla?|oklch|oklab|lab|lch)\((?:[-+\d.%\s,/]|none|deg)*\)$/i;
const NAMED_COLORS = new Set(["transparent", "black", "white"]);

/**
 * Whether `value` is a color a theme may hold: hex, a color function with numeric arguments, or
 * one of a few keywords. Themes are written into a stylesheet, so nothing else gets through; where
 * the browser's CSS parser is available, it must also read the value as a color (`rgb()` with no
 * arguments passes the pattern, not the parser).
 */
export function isThemeColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const color = value.trim();
  const shaped =
    color.length <= 64 &&
    (HEX_COLOR.test(color) || FUNCTION_COLOR.test(color) || NAMED_COLORS.has(color.toLowerCase()));
  if (!shaped) return false;
  return typeof CSS === "undefined" || typeof CSS.supports !== "function"
    ? true
    : CSS.supports("color", color);
}

/** The entries of `value` whose key passes `isKey` and whose value is a theme color. */
function colorMap(value: unknown, isKey: (key: string) => boolean): Record<string, string> {
  if (!isRecord(value)) return {};
  const colors: Record<string, string> = {};
  for (const [key, color] of Object.entries(value)) {
    if (isKey(key) && isThemeColor(color)) colors[key] = color.trim();
  }
  return colors;
}

const TERMINAL_COLOR_SET = new Set<string>(TERMINAL_COLOR_NAMES);

export const isUiTokenName = (key: string) => UI_TOKEN_NAMES.has(key);
export const isTerminalColorName = (key: string): key is TerminalColorName =>
  TERMINAL_COLOR_SET.has(key);
export const isSyntaxRoleId = (key: string) => SYNTAX_ROLE_IDS.has(key);

/** A theme's color fields, checked: unknown names and invalid colors are dropped. */
export function themeColors(value: Record<string, unknown>) {
  return {
    colors: colorMap(value.colors, isUiTokenName),
    terminal: colorMap(value.terminal, isTerminalColorName) as Partial<TerminalColors>,
    syntax: colorMap(value.syntax, isSyntaxRoleId),
  };
}

function parseStoredTheme(value: unknown): LoxelTheme | null {
  if (!isRecord(value)) return null;
  const { id, name, base } = value;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (base !== "light" && base !== "dark") return null;
  if (isBuiltinTheme(id)) return null;
  return { id, name, base, ...themeColors(value) };
}

function isValidStoredTheme(value: unknown): boolean {
  const parsed = parseStoredTheme(value);
  if (!parsed || !isRecord(value)) return false;
  const same = (a: unknown, b: Record<string, string>) =>
    isRecord(a) && Object.keys(a).length === Object.keys(b).length;
  return (
    same(value.colors, parsed.colors) &&
    same(value.terminal, parsed.terminal) &&
    same(value.syntax, parsed.syntax)
  );
}

/**
 * Stored or synced theme settings, checked: a missing or malformed choice takes its default, a
 * malformed custom theme is dropped and invalid colors in one are removed. Valid settings come
 * back as the same object, so a synced update that leaves them alone restyles nothing.
 */
export function parseThemeSettings(value: unknown): ThemeSettings {
  const settings = isRecord(value) ? value : {};
  const { light, dark, custom } = settings;
  if (
    typeof light === "string" &&
    typeof dark === "string" &&
    Array.isArray(custom) &&
    custom.every(isValidStoredTheme)
  ) {
    // Every field was just checked.
    return settings as unknown as ThemeSettings;
  }
  return {
    light: typeof light === "string" ? light : DEFAULT_THEME_SETTINGS.light,
    dark: typeof dark === "string" ? dark : DEFAULT_THEME_SETTINGS.dark,
    custom: Array.isArray(custom)
      ? custom.map(parseStoredTheme).filter((t): t is LoxelTheme => t !== null)
      : [],
  };
}
