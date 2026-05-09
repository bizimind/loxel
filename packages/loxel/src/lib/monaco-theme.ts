import * as monaco from "monaco-editor";

/**
 * Read a CSS variable from the document, resolved to a hex color string.
 * Works with any CSS color format (hex, oklch, rgb, etc.) since
 * getComputedStyle returns the resolved rgb/rgba value.
 */
function resolveColorVar(name: string, el: Element): string {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (raw.startsWith("#")) return raw;

  // Parse rgb(r, g, b) or rgba(r, g, b, a)
  const match = raw.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    const r = Number(match[1]).toString(16).padStart(2, "0");
    const g = Number(match[2]).toString(16).padStart(2, "0");
    const b = Number(match[3]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  return raw;
}

/** Read a set of theme colors from CSS variables on the given element */
function readThemeColors(el: Element) {
  return {
    editorBg: resolveColorVar("--editor-surface", el),
    editorFg: resolveColorVar("--foreground", el),
    lineNumber: resolveColorVar("--editor-line-number", el),
    lineNumberActive: resolveColorVar("--editor-line-number-active", el),
  };
}

/**
 * Register custom Monaco themes that match the loxel JetBrains-inspired design.
 * Reads colors from CSS variables so index.css is the single source of truth.
 * Uses `inherit: true` to get Monaco's built-in syntax token colors,
 * overriding only the editor chrome (background, foreground, gutters).
 */
export function registerMonacoThemes(): void {
  // Read light mode colors from :root
  const light = readThemeColors(document.documentElement);

  // Read dark mode colors via a temporary .dark element
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

  const _white = "dfe1e5"; // #dfe1e5
  const blue = "6da0cf"; // #6da0cf
  const darkblue = "7a7e85"; // #7a7e85
  const red = "f68383"; // #f68383
  const green = "93b196"; // #93b196
  monaco.editor.defineTheme("loxel-dark", {
    base: "vs-dark",
    inherit: true,
    //     {
    //     "view-line": "#dfe1e5",
    //     "SPAN": "#dfe1e5",
    //     "mtk1": "#dfe1e5",
    //     "mtk17 bracket-highlighting-4": "#525252",
    //     "mtk5": "#c498ed",
    //     "mtk17": "#93b196",
    //     "mtk7": "#f68383",
    //     "mtk24": "#6da0cf",
    //     "mtk17 bracket-highlighting-3": "#ffd700",
    //     "mtk12": "#7a7e85",
    //     "mtk21": "#c6c8c9",
    //     "mtk19": "#2fbaa3",
    //     "mtk20": "#f5b773",
    //     "mtk17 bracket-highlighting-1": "#da70d6",
    //     "mtk17 bracket-highlighting-2": "#179fff",
    //     "view-lines monaco-mouse-cursor-text": "#dfe1e5"
    // }
    rules: [
      // { token: "comment", foreground: "7A7E85", fontStyle: "italic" },
      { token: "comment.doc", foreground: darkblue, fontStyle: "italic" },
      { token: "comment", foreground: darkblue },
      { token: "keyword", foreground: blue },
      { token: "string", foreground: red },
      { token: "string.escape", foreground: "D5B778" },
      { token: "number", foreground: "2AACB8" },
      { token: "number.hex", foreground: "2AACB8" },
      { token: "regexp", foreground: "d16969" },

      { token: "type", foreground: "BDBEC4" },
      { token: "type.identifier", foreground: "BDBEC4" },
      // { token: "type.identifier.ts", foreground: "30BBA2" },

      // { token: "type.identifier", foreground: "2FBAA3" },
      { token: "identifier", foreground: "BCBEC4" },
      // { token: "identifier.ts", foreground: "BCBEC4" },
      { token: "property.declaration", foreground: "C87DBB" },
      { token: "method.declaration", foreground: "57A8F5" },
      { token: "function.declaration", foreground: "57A8F5" },
      { token: "variable.predefined", foreground: "C87DBB" },
      { token: "variable.declaration", foreground: "C87DBB" },
      { token: "predefined", foreground: "C87DBB" },
      { token: "function", foreground: "57A8F5" },
      { token: "method", foreground: "57A8F5" },
      { token: "variable.predefined", foreground: "CF8E6D" },
      { token: "attribute.name", foreground: "C87DBB" },
      { token: "attribute.value", foreground: "6AAB73" },
      { token: "metatag", foreground: "CF8E6D" },
      { token: "constant", foreground: "C77DBB" },
      { token: "delimiter", foreground: green },
      { token: "tag", foreground: green },
      { token: "operator", foreground: "BCBEC4" },
      // Semantic token rules — overlayed by DocumentSemanticTokensProvider
      { token: "member", foreground: "57A8F5" },
      // { token: "member", foreground: "C87DBB" },
      // { token: "member.declaration", foreground: "C87DBB" },
      { token: "enumMember", foreground: "C87DBB" },
      // { token: "class", foreground: "30BBA2" },
      { token: "class", foreground: "BDBEC4" },
      { token: "interface", foreground: "BDBEC4" },
      // { token: "property", foreground: "57A8F5" },
      { token: "property", foreground: "C87DBB" },
      { token: "enum", foreground: "2FBAA3" },
      { token: "namespace", foreground: "2FBAA3" },
      { token: "typeParameter", foreground: "2FBAA3" },
      { token: "parameter", foreground: "BDBEC4" },
      { token: "variable", foreground: "BDBEC4" },
      { token: "variable.readonly.local", foreground: "BDBEC4" },
      { token: "variable.readonly", foreground: "C77DBB" },
      { token: "jsxComponent", foreground: "30BBA2" },
      { token: "jsxTag", foreground: green },
      { token: "jsxBracket", foreground: green },
      { token: "delimiter.html", foreground: green },
      // { token: "property.declaration.readonly", foreground: "57A8F5" },
    ],
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

export function getMonacoThemeName(darkMode: boolean): string {
  return darkMode ? "loxel-dark" : "loxel-light";
}

/** Map from Shiki/highlighter language IDs that differ in Monaco */
const LANG_MAP: Record<string, string> = {
  bash: "shell",
  shellscript: "shell",
  jsx: "javascript",
  tsx: "typescript",
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
