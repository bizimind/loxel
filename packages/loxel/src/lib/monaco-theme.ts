import { textmateThemeToMonacoTheme } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import type { Highlighter } from "shiki";

function resolveColorVar(name: string, el: Element): string {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (raw.startsWith("#")) return raw;

  const match = raw.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    const r = Number(match[1]).toString(16).padStart(2, "0");
    const g = Number(match[2]).toString(16).padStart(2, "0");
    const b = Number(match[3]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  return raw;
}

function readThemeColors(el: Element) {
  return {
    editorBg: resolveColorVar("--editor-surface", el),
    editorFg: resolveColorVar("--foreground", el),
    lineNumber: resolveColorVar("--editor-line-number", el),
    lineNumberActive: resolveColorVar("--editor-line-number-active", el),
  };
}

// Semantic token rules from LSPs (tsgo, Astro LS) — these layer on top of
// TextMate syntax tokens and are styled by Monaco's semantic token renderer.
const DARK_SEMANTIC_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: "function", foreground: "659488" }, // #659488
  // { token: "function", foreground: "57A8F5" },
  { token: "member", foreground: "659488" }, // #659488
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

/**
 * Register initial Monaco themes synchronously so editors that mount before
 * the Shiki highlighter resolves still have valid themes. These are basic
 * fallbacks — `enhanceMonacoThemes` replaces them with Shiki-converted themes
 * that include full TextMate scope rules + CSS variable editor chrome colors.
 */
export function registerMonacoThemes(): void {
  const darkEl = document.createElement("div");
  darkEl.className = "dark";
  document.documentElement.appendChild(darkEl);
  const dark = readThemeColors(darkEl);
  darkEl.remove();

  monaco.editor.defineTheme("loxel-dark", {
    base: "vs-dark",
    inherit: true,
    rules: DARK_SEMANTIC_RULES,
    colors: {
      "editor.background": dark.editorBg,
      "editor.foreground": dark.editorFg,
      "editorLineNumber.foreground": dark.lineNumber,
      "editorLineNumber.activeForeground": dark.lineNumberActive,
      "editor.lineHighlightBackground": dark.editorBg,
      "editorGutter.background": dark.editorBg,
      "editor.selectionBackground": "#264f78",
      "editorCursor.foreground": "#BCBEC4",
      "editorIndentGuide.background": "#404040",
      "editorIndentGuide.activeBackground": "#707070",
      "editorBracketMatch.background": "#0064001a",
      "editorBracketMatch.border": "#888888",
      "editorWhitespace.foreground": "#e3e4e229",
    },
  });
}

/**
 * Re-define Monaco themes using Shiki-converted TextMate rules, overlaying
 * CSS variable editor chrome colors and semantic token rules. Called after
 * `shikiToMonaco` registers its tokenizer-internal theme data.
 */
export function enhanceMonacoThemes(highlighter: Highlighter): void {
  const darkEl = document.createElement("div");
  darkEl.className = "dark";
  document.documentElement.appendChild(darkEl);
  const dark = readThemeColors(darkEl);
  darkEl.remove();

  const darkBase = textmateThemeToMonacoTheme(
    highlighter.getTheme("loxel-dark"),
  ) as monaco.editor.IStandaloneThemeData;
  monaco.editor.defineTheme("loxel-dark", {
    ...darkBase,
    rules: [...darkBase.rules, ...DARK_SEMANTIC_RULES],
    colors: {
      ...darkBase.colors,
      "editor.background": dark.editorBg,
      "editor.foreground": dark.editorFg,
      "editorLineNumber.foreground": dark.lineNumber,
      "editorLineNumber.activeForeground": dark.lineNumberActive,
      "editor.lineHighlightBackground": dark.editorBg,
      "editorGutter.background": dark.editorBg,
    },
  });
}

export function getMonacoThemeName(_darkMode: boolean): string {
  return "loxel-dark";
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
  toml: "ini",
};

/**
 * Convert a Shiki language ID to a Monaco language ID.
 * Monaco and Shiki use different identifiers for some languages.
 */
export function toMonacoLanguage(shikiLang: string | null): string {
  if (!shikiLang) return "plaintext";
  return LANG_MAP[shikiLang] ?? shikiLang;
}
