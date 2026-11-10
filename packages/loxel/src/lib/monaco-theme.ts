import type { SemanticTokenStyling } from "@bizimind/monaco-lsp-client";
import { textmateThemeToMonacoTheme } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import type { Highlighter, ThemeRegistrationRaw } from "shiki";

import { loxelDark, loxelLight } from "./loxel-themes";

/** Resolve any CSS color (hex, rgb(), oklch(), color-mix(), ...) to the hex form Monaco parses. */
function toHexColor(raw: string): string {
  if (/^#[\da-f]{3,8}$/i.test(raw)) return raw;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return raw;
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = [r, g, b, ...(a === 255 ? [] : [a])].map((c) => c.toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

/**
 * The editor chrome colors that follow the app's CSS tokens, read from a probe element carrying the
 * mode's class (`.dark` tokens, or the `:root` tokens that `.light` restates under a `.dark` root).
 */
function readThemeColors(mode: ThemeMode): Record<string, string> {
  const probe = document.createElement("div");
  probe.className = mode;
  document.documentElement.appendChild(probe);
  const style = getComputedStyle(probe);
  const color = (name: string) => toHexColor(style.getPropertyValue(name).trim());
  const editorBg = color("--editor-surface");
  const colors = {
    "editor.background": editorBg,
    "editor.foreground": color("--foreground"),
    "editorLineNumber.foreground": color("--editor-line-number"),
    "editorLineNumber.activeForeground": color("--editor-line-number-active"),
    "editorGutter.background": editorBg,
    // Dark keeps no current-line fill; light paints JetBrains' faint blue caret row.
    "editor.lineHighlightBackground": mode === "dark" ? editorBg : "#EFF3FB",
  };
  probe.remove();
  return colors;
}

// Semantic token rules from LSPs — these layer on top of TextMate syntax tokens and are
// styled by Monaco's semantic token renderer. Only deliberate choices belong here: a token
// type without a rule keeps its TextMate color (see `SEMANTIC_TOKEN_STYLING`).
const DARK_SEMANTIC_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: "function", foreground: "659488" }, // #659488
  // { token: "function", foreground: "57A8F5" },
  { token: "member", foreground: "659488" }, // #659488
  { token: "method", foreground: "659488" }, // #659488
  { token: "decorator", foreground: "659488" }, // #659488
  { token: "keyword", foreground: "6DA0CF" }, // #6DA0CF
  { token: "type", foreground: "BDBEC4" }, // #BDBEC4
  // Python `self` / `cls`, matching the TextMate `variable.language` color
  { token: "selfParameter", foreground: "CF8E6D" }, // #CF8E6D
  { token: "clsParameter", foreground: "CF8E6D" }, // #CF8E6D
  { token: "enumMember", foreground: "a6859e" }, // #a6859e
  { token: "class", foreground: "BDBEC4" }, // #BDBEC4
  { token: "interface", foreground: "BDBEC4" }, // #BDBEC4
  { token: "property", foreground: "a6859e" }, // #a6859e
  { token: "enum", foreground: "659488" }, // #659488
  { token: "namespace", foreground: "659488" }, // #659488
  { token: "typeParameter", foreground: "659488" }, // #659488
  { token: "parameter", foreground: "BDBEC4" }, // #BDBEC4
  { token: "variable", foreground: "BDBEC4" }, // #BDBEC4
  { token: "variable.readonly.local", foreground: "BDBEC4" }, // #BDBEC4
  { token: "variable.readonly", foreground: "a6859e" }, // #a6859e
  { token: "delimiter.html", foreground: "93B196" }, // #93B196
];

/** `DARK_SEMANTIC_RULES` in the IntelliJ Light palette of `loxelLight`. */
const LIGHT_SEMANTIC_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: "function", foreground: "00627A" }, // #00627A
  { token: "member", foreground: "00627A" }, // #00627A
  { token: "method", foreground: "00627A" }, // #00627A
  { token: "decorator", foreground: "9E880D" }, // #9E880D
  { token: "keyword", foreground: "0033B3" }, // #0033B3
  { token: "type", foreground: "000000" }, // #000000
  // Python `self` / `cls`, matching loxelLight's TextMate self/cls color
  { token: "selfParameter", foreground: "94558D" }, // #94558D
  { token: "clsParameter", foreground: "94558D" }, // #94558D
  { token: "enumMember", foreground: "871094", fontStyle: "italic" }, // #871094
  { token: "class", foreground: "000000" }, // #000000
  { token: "interface", foreground: "000000" }, // #000000
  { token: "property", foreground: "871094" }, // #871094
  { token: "enum", foreground: "000000" }, // #000000
  { token: "namespace", foreground: "000000" }, // #000000
  { token: "typeParameter", foreground: "007E8A" }, // #007E8A
  { token: "parameter", foreground: "1E1F22" }, // #1E1F22
  { token: "variable", foreground: "1E1F22" }, // #1E1F22
  { token: "variable.readonly.local", foreground: "1E1F22" }, // #1E1F22
  { token: "variable.readonly", foreground: "871094" }, // #871094
  { token: "delimiter.html", foreground: "0033B3" }, // #0033B3
];

/**
 * Light editor chrome that no CSS token drives: JetBrains New UI Light selection, search and
 * occurrence highlights, guides, inlay hints, scrollbars and widgets. Dark keeps Monaco's
 * `vs-dark` defaults for these.
 */
const LIGHT_CHROME_COLORS: Record<string, string> = {
  "editor.lineHighlightBorder": "#00000000",
  "editor.inactiveSelectionBackground": "#BCD6F7",
  "editor.selectionHighlightBackground": "#8B7BE514",
  "editor.selectionHighlightBorder": "#00000000",
  "editor.wordHighlightBackground": "#8B7BE52E",
  "editor.wordHighlightStrongBackground": "#8B7BE51A",
  "editor.wordHighlightTextBackground": "#8B7BE52E",
  "editor.findMatchBackground": "#FFCF5C",
  "editor.findMatchHighlightBackground": "#FFE99A99",
  "editor.findRangeHighlightBackground": "#EDF3FF80",
  "editor.rangeHighlightBackground": "#EDF3FF80",
  "editor.hoverHighlightBackground": "#E4ECFB80",
  "editor.linkedEditingBackground": "#EDEBFC",
  "editorIndentGuide.background1": "#E1E3E8",
  "editorIndentGuide.activeBackground1": "#C5C9D1",
  "editorRuler.foreground": "#EBECF0",
  "editorCodeLens.foreground": "#818594",
  "editorInlayHint.foreground": "#5E6270",
  "editorInlayHint.background": "#EDEEF2",
  "editorInlayHint.typeForeground": "#5E6270",
  "editorInlayHint.typeBackground": "#EDEEF2",
  "editorInlayHint.parameterForeground": "#5E6270",
  "editorInlayHint.parameterBackground": "#EDEEF2",
  "editorBracketHighlight.foreground1": "#8F6200",
  "editorBracketHighlight.foreground2": "#A0379B",
  "editorBracketHighlight.foreground3": "#2856C9",
  "editorBracketHighlight.unexpectedBracket.foreground": "#E55765",
  "editorError.foreground": "#E55765",
  "editorWarning.foreground": "#C7A450",
  "editorInfo.foreground": "#3574F0",
  "editorUnnecessaryCode.opacity": "#00000080",
  "editorOverviewRuler.border": "#00000000",
  "editorOverviewRuler.findMatchForeground": "#E2B94C",
  "editorOverviewRuler.selectionHighlightForeground": "#A6C3F2",
  "editorOverviewRuler.wordHighlightForeground": "#A69CEB",
  "editorOverviewRuler.wordHighlightStrongForeground": "#8E9BEA",
  "editorOverviewRuler.errorForeground": "#E55765",
  "editorOverviewRuler.warningForeground": "#E2B94C",
  "editorOverviewRuler.infoForeground": "#3574F0",
  "scrollbar.shadow": "#00000000",
  "scrollbarSlider.background": "#1E1F221F",
  "scrollbarSlider.hoverBackground": "#1E1F2233",
  "scrollbarSlider.activeBackground": "#1E1F2247",
  "minimap.background": "#FFFFFF",
  "minimapSlider.background": "#1E1F2214",
  "minimapSlider.hoverBackground": "#1E1F2224",
  "minimapSlider.activeBackground": "#1E1F2233",
  "editorWidget.background": "#FFFFFF",
  "editorWidget.foreground": "#1E1F22",
  "editorWidget.border": "#DFE1E5",
  "editorWidget.resizeBorder": "#3574F0",
  "editorHoverWidget.background": "#FFFFFF",
  "editorHoverWidget.foreground": "#1E1F22",
  "editorHoverWidget.border": "#DFE1E5",
  "editorHoverWidget.statusBarBackground": "#F7F8FA",
  "editorSuggestWidget.background": "#FFFFFF",
  "editorSuggestWidget.foreground": "#1E1F22",
  "editorSuggestWidget.border": "#DFE1E5",
  "editorSuggestWidget.selectedBackground": "#D4E2FF",
  "editorSuggestWidget.selectedForeground": "#1E1F22",
  "editorSuggestWidget.highlightForeground": "#2A5DD8",
  "editorSuggestWidget.focusHighlightForeground": "#2A5DD8",
  "editorStickyScroll.background": "#FFFFFF",
  "editorStickyScrollHover.background": "#F2F4F7",
  "editorGhostText.foreground": "#A8ADBD",
  "editorLightBulb.foreground": "#C7A450",
  "editorMarkerNavigation.background": "#FFFFFF",
  "input.background": "#FFFFFF",
  "input.foreground": "#1E1F22",
  "input.border": "#C9CCD6",
  "input.placeholderForeground": "#8C8C8C",
  "inputOption.activeBackground": "#D4E2FF",
  "inputOption.activeBorder": "#3574F0",
  focusBorder: "#3574F0",
  "list.hoverBackground": "#EDF3FF",
  "list.activeSelectionBackground": "#D4E2FF",
  "list.activeSelectionForeground": "#1E1F22",
  "list.inactiveSelectionBackground": "#DFE1E5",
  "list.highlightForeground": "#2A5DD8",
  "peekView.border": "#3574F0",
  "peekViewTitle.background": "#F7F8FA",
  "peekViewTitleLabel.foreground": "#1E1F22",
  "peekViewTitleDescription.foreground": "#6C707E",
  "peekViewEditor.background": "#FFFFFF",
  "peekViewEditorGutter.background": "#FFFFFF",
  "peekViewEditor.matchHighlightBackground": "#FFE99A99",
  "peekViewResult.background": "#F7F8FA",
  "peekViewResult.fileForeground": "#1E1F22",
  "peekViewResult.lineForeground": "#494B57",
  "peekViewResult.selectionBackground": "#D4E2FF",
  "peekViewResult.selectionForeground": "#1E1F22",
  "peekViewResult.matchHighlightBackground": "#FFE99A99",
};

type ThemeMode = "dark" | "light";

const THEMES: Record<
  ThemeMode,
  {
    name: string;
    textmate: ThemeRegistrationRaw;
    semanticRules: monaco.editor.ITokenThemeRule[];
    chrome: Record<string, string>;
  }
> = {
  dark: { name: "loxel-dark", textmate: loxelDark, semanticRules: DARK_SEMANTIC_RULES, chrome: {} },
  light: {
    name: "loxel-light",
    textmate: loxelLight,
    semanticRules: LIGHT_SEMANTIC_RULES,
    chrome: LIGHT_CHROME_COLORS,
  },
};

const THEME_MODES: ThemeMode[] = ["dark", "light"];

/**
 * What the theme styles, for language clients: the union over both themes, which style the same
 * types. A type counts only with a rule of its own: Monaco paints `punctuation` in the default
 * foreground even with a `punctuation.definition.comment` rule.
 */
export const SEMANTIC_TOKEN_STYLING: SemanticTokenStyling = {
  types: new Set(
    THEME_MODES.flatMap((mode) => [
      ...THEMES[mode].semanticRules.map((rule) => rule.token),
      ...THEMES[mode].textmate.settings.flatMap((setting) => setting.scope ?? []),
    ]),
  ),
  modifiers: new Set(
    THEME_MODES.flatMap((mode) =>
      THEMES[mode].semanticRules.flatMap((rule) => rule.token.split(".").slice(1)),
    ),
  ),
};

/**
 * Register initial Monaco themes synchronously so editors that mount before
 * the Shiki highlighter resolves still have valid themes. These are basic
 * fallbacks — `enhanceMonacoThemes` replaces them with Shiki-converted themes
 * that include full TextMate scope rules + CSS variable editor chrome colors.
 */
export function registerMonacoThemes(): void {
  for (const mode of THEME_MODES) {
    const theme = THEMES[mode];
    monaco.editor.defineTheme(theme.name, {
      base: mode === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: theme.semanticRules,
      colors: { ...theme.textmate.colors, ...theme.chrome, ...readThemeColors(mode) },
    });
  }
}

/**
 * Re-define Monaco themes using Shiki-converted TextMate rules, overlaying
 * CSS variable editor chrome colors and semantic token rules. Called after
 * `shikiToMonaco` registers its tokenizer-internal theme data.
 */
export function enhanceMonacoThemes(highlighter: Highlighter): void {
  for (const mode of THEME_MODES) {
    const theme = THEMES[mode];
    const base = textmateThemeToMonacoTheme(
      highlighter.getTheme(theme.name),
    ) as monaco.editor.IStandaloneThemeData;
    monaco.editor.defineTheme(theme.name, {
      ...base,
      rules: [...base.rules, ...theme.semanticRules],
      colors: { ...base.colors, ...theme.chrome, ...readThemeColors(mode) },
    });
  }
}

export function getMonacoThemeName(darkMode: boolean): string {
  return THEMES[darkMode ? "dark" : "light"].name;
}

/** Map from Shiki/highlighter language IDs that differ in Monaco */
const LANG_MAP: Record<string, string> = {
  bash: "shell",
  shellscript: "shell",
  jsonc: "json",
  jsonl: "json",
  svelte: "html",
  vue: "html",
  dotenv: "ini",
};

/**
 * Convert a Shiki language ID to a Monaco language ID.
 * Monaco and Shiki use different identifiers for some languages.
 */
export function toMonacoLanguage(shikiLang: string | null): string {
  if (!shikiLang) return "plaintext";
  return LANG_MAP[shikiLang] ?? shikiLang;
}
