import type { Highlighter } from "shiki";

import { textmateThemeToMonacoTheme } from "@shikijs/monaco";
import * as monaco from "monaco-editor";

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
  { token: "member", foreground: "57A8F5" },
  { token: "enumMember", foreground: "C87DBB" },
  { token: "class", foreground: "BDBEC4" },
  { token: "interface", foreground: "BDBEC4" },
  { token: "property", foreground: "C87DBB" },
  { token: "enum", foreground: "2FBAA3" },
  { token: "namespace", foreground: "2FBAA3" },
  { token: "typeParameter", foreground: "2FBAA3" },
  { token: "parameter", foreground: "BDBEC4" },
  { token: "variable", foreground: "BDBEC4" },
  { token: "variable.readonly.local", foreground: "BDBEC4" },
  { token: "variable.readonly", foreground: "C77DBB" },
  { token: "jsxComponent", foreground: "30BBA2" },
  { token: "jsxTag", foreground: "93B196" },
  { token: "jsxBracket", foreground: "93B196" },
  { token: "delimiter.html", foreground: "93B196" },
];

const LIGHT_SEMANTIC_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: "member", foreground: "795E26" },
  { token: "enumMember", foreground: "0000FF" },
  { token: "class", foreground: "267F99" },
  { token: "interface", foreground: "267F99" },
  { token: "property", foreground: "E50000" },
  { token: "enum", foreground: "267F99" },
  { token: "namespace", foreground: "267F99" },
  { token: "typeParameter", foreground: "267F99" },
  { token: "parameter", foreground: "001080" },
  { token: "variable", foreground: "001080" },
  { token: "variable.readonly.local", foreground: "001080" },
  { token: "variable.readonly", foreground: "0000FF" },
  { token: "jsxComponent", foreground: "267F99" },
  { token: "jsxTag", foreground: "800000" },
  { token: "jsxBracket", foreground: "800000" },
  { token: "delimiter.html", foreground: "800000" },
];

/**
 * Register initial Monaco themes synchronously so editors that mount before
 * the Shiki highlighter resolves still have valid themes. These are basic
 * fallbacks — `enhanceMonacoThemes` replaces them with Shiki-converted themes
 * that include full TextMate scope rules + CSS variable editor chrome colors.
 */
export function registerMonacoThemes(): void {
  const light = readThemeColors(document.documentElement);

  const darkEl = document.createElement("div");
  darkEl.className = "dark";
  document.documentElement.appendChild(darkEl);
  const dark = readThemeColors(darkEl);
  darkEl.remove();

  monaco.editor.defineTheme("loxel-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": light.editorBg,
      "editor.foreground": light.editorFg,
      "editorLineNumber.foreground": light.lineNumber,
      "editorLineNumber.activeForeground": light.lineNumberActive,
      "editor.lineHighlightBackground": light.editorBg,
      "editorGutter.background": light.editorBg,
    },
  });

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
  const light = readThemeColors(document.documentElement);

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

  const lightBase = textmateThemeToMonacoTheme(
    highlighter.getTheme("loxel-light"),
  ) as monaco.editor.IStandaloneThemeData;
  monaco.editor.defineTheme("loxel-light", {
    ...lightBase,
    rules: [...lightBase.rules, ...LIGHT_SEMANTIC_RULES],
    colors: {
      ...lightBase.colors,
      "editor.background": light.editorBg,
      "editor.foreground": light.editorFg,
      "editorLineNumber.foreground": light.lineNumber,
      "editorLineNumber.activeForeground": light.lineNumberActive,
      "editor.lineHighlightBackground": light.editorBg,
      "editorGutter.background": light.editorBg,
    },
  });
}

export function getMonacoThemeName(darkMode: boolean): string {
  return darkMode ? "loxel-dark" : "loxel-light";
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
