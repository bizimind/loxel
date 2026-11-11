/**
 * Syntax colors for markdown code blocks, from the code editor's own highlighter: the same Shiki
 * grammars and theme Monaco uses, so a snippet looks the same in a block as in a file.
 *
 * Each block language keeps its CodeMirror parser (from `@codemirror/language-data`) for editing
 * behavior such as indentation and comment toggling; only the coloring comes from Shiki. Languages
 * only Shiki has are added with a plain parser, and languages only CodeMirror has keep
 * `FALLBACK_HIGHLIGHT`.
 */
import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages as codeMirrorLanguages } from "@codemirror/language-data";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type Highlighter, bundledLanguagesInfo } from "shiki";

import { BUNDLED_LANGUAGES, getHighlighter } from "@/lib/highlighter";
import { getMonacoThemeName } from "@/lib/monaco-theme";

/** For languages Shiki doesn't load: CodeMirror's parse, in the editor theme's main colors. */
const FALLBACK_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: "#cf8e6d" },
  { tag: tags.operator, color: "#cf8e6d" },
  { tag: tags.name, color: "#bcbec4" },
  { tag: tags.variableName, color: "#bcbec4" },
  { tag: tags.propertyName, color: "#c77dbb" },
  { tag: tags.function(tags.variableName), color: "#56a8f5" },
  { tag: tags.function(tags.propertyName), color: "#56a8f5" },
  { tag: tags.definition(tags.variableName), color: "#bcbec4" },
  { tag: tags.typeName, color: "#2fbaa3" },
  { tag: tags.className, color: "#2fbaa3" },
  { tag: tags.string, color: "#6aab73" },
  { tag: tags.special(tags.string), color: "#6aab73" },
  { tag: tags.number, color: "#2aacb8" },
  { tag: tags.bool, color: "#cf8e6d" },
  { tag: tags.null, color: "#cf8e6d" },
  { tag: tags.comment, color: "#7a7e85", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#7a7e85", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#7a7e85", fontStyle: "italic" },
  { tag: tags.meta, color: "#bbb529" },
  { tag: tags.regexp, color: "#6aab73" },
  { tag: tags.tagName, color: "#e8bf6a" },
  { tag: tags.attributeName, color: "#bababa" },
  { tag: tags.attributeValue, color: "#6a8759" },
  { tag: tags.heading, color: "#bcbec4", fontWeight: "bold" },
  { tag: tags.link, color: "#56a8f5", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
]);

/**
 * An active style with no rules: it keeps CodeMirror's basicSetup from painting its default colors
 * (a fallback style that applies when no other is active) under Shiki's.
 */
const NO_CODEMIRROR_COLORS = syntaxHighlighting(HighlightStyle.define([]));

/** A parser that leaves the whole text unstyled, for languages only Shiki knows. */
const PLAIN_LANGUAGE = StreamLanguage.define<null>({
  name: "plain",
  token: (stream) => {
    stream.skipToEnd();
    return null;
  },
});

const BUNDLED = new Set<string>(BUNDLED_LANGUAGES);
/** The bundled Shiki languages, each with every name a block may use for it. */
const SHIKI_LANGUAGES = bundledLanguagesInfo.filter(
  (info) => BUNDLED.has(info.id) || (info.aliases ?? []).some((alias) => BUNDLED.has(alias)),
);
/** Every name and alias of a bundled Shiki language, to the Shiki id. */
const SHIKI_ID_BY_NAME = new Map<string, string>(
  SHIKI_LANGUAGES.flatMap((info) =>
    [info.id, info.name, ...(info.aliases ?? [])].map((name) => [name.toLowerCase(), info.id]),
  ),
);

/** The Shiki language for a CodeMirror language description, matched by its name and aliases. */
function shikiIdFor(language: LanguageDescription): string | undefined {
  for (const name of [language.name, ...language.alias]) {
    const id = SHIKI_ID_BY_NAME.get(name.toLowerCase());
    if (id) return id;
  }
  return undefined;
}

/** A CodeMirror extension, as `LanguageSupport` takes them (without importing `@codemirror/state`). */
type Extension = NonNullable<ConstructorParameters<typeof LanguageSupport>[1]>;

/** Shiki's `FontStyle` bits. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

const markCache = new Map<string, Decoration>();

/** A mark for a token's color and font style, or null when it has neither. */
function tokenMark(color: string | undefined, fontStyle: number | undefined): Decoration | null {
  const style = fontStyle !== undefined && fontStyle > 0 ? fontStyle : 0;
  if (!color && !style) return null;
  return styleMark(color, style);
}

function styleMark(color: string | undefined, style: number): Decoration {
  const key = `${color ?? ""}|${style}`;
  const cached = markCache.get(key);
  if (cached) return cached;
  const css = [
    color ? `color: ${color}` : "",
    style & ITALIC ? "font-style: italic" : "",
    style & BOLD ? "font-weight: bold" : "",
    style & UNDERLINE ? "text-decoration: underline" : "",
  ].filter(Boolean);
  const mark = Decoration.mark({ attributes: { style: css.join("; ") } });
  markCache.set(key, mark);
  return mark;
}

/**
 * Monaco's bracket pair colors (its defaults, which Loxel's themes don't override): a cycle by
 * nesting depth across all bracket kinds, and a color for a closer with no opener.
 */
const BRACKET_COLORS = {
  dark: { levels: ["#FFD700", "#DA70D6", "#179FFF"], unexpected: "rgba(255, 18, 18, 0.8)" },
  light: { levels: ["#0431FA", "#319331", "#7B3814"], unexpected: "rgba(255, 18, 18, 0.8)" },
} as const;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** Shiki's font style bits for a theme rule's `fontStyle` string. */
function fontStyleBits(fontStyle: string | undefined): number {
  const words = new Set((fontStyle ?? "").split(/[\s,]+/));
  return (
    (words.has("italic") ? ITALIC : 0) |
    (words.has("bold") ? BOLD : 0) |
    (words.has("underline") ? UNDERLINE : 0)
  );
}

const colorStyleKey = (color: string, style: number) =>
  `${color.replace(/^#/, "").toLowerCase()}|${style}`;

const scopesByTheme = new Map<string, Map<string, string>>();

/**
 * Whether Monaco treats a token of this color and style as a string, comment or regex, whose
 * brackets it leaves uncolored. Monaco sees the scope of the first theme rule with the token's
 * color and style (that's the scope `@shikijs/monaco` hands it), classified by Monaco's
 * `STANDARD_TOKEN_TYPE_REGEXP`; this mirrors both so blocks color the same brackets.
 */
function isTextToken(highlighter: Highlighter, themeName: string, color: string, style: number) {
  let scopes = scopesByTheme.get(themeName);
  if (!scopes) {
    scopes = new Map();
    for (const rule of highlighter.getTheme(themeName).settings) {
      const foreground = rule.settings.foreground;
      if (!foreground) continue;
      const key = colorStyleKey(foreground, fontStyleBits(rule.settings.fontStyle));
      const scope = Array.isArray(rule.scope) ? rule.scope[0] : rule.scope;
      if (!scopes.has(key)) scopes.set(key, scope ?? "");
    }
    scopesByTheme.set(themeName, scopes);
  }
  const scope = scopes.get(colorStyleKey(color, style)) ?? "";
  return /\b(comment|string|regex|regexp)\b/.test(scope);
}

function shikiDecorations(highlighter: Highlighter, lang: string, text: string): DecorationSet {
  const isDark = document.documentElement.classList.contains("dark");
  const themeName = getMonacoThemeName(isDark);
  const brackets = isDark ? BRACKET_COLORS.dark : BRACKET_COLORS.light;
  const lines = highlighter.codeToTokensBase(text, {
    lang: lang as Parameters<Highlighter["codeToTokensBase"]>[1]["lang"],
    theme: highlighter.getTheme(themeName),
  });
  const ranges: ReturnType<Decoration["range"]>[] = [];
  let depth = 0;
  for (const token of lines.flat()) {
    const style = Math.max(token.fontStyle ?? 0, 0);
    const mark = tokenMark(token.color, style);
    const isCode = !token.color || !isTextToken(highlighter, themeName, token.color, style);
    let runStart = token.offset;
    for (let i = 0; i < token.content.length; i++) {
      const char = token.content.charAt(i);
      let color: string | undefined;
      if (isCode && OPENERS.has(char)) color = brackets.levels[depth++ % brackets.levels.length];
      else if (isCode && CLOSERS.has(char)) {
        color = depth > 0 ? brackets.levels[--depth % brackets.levels.length] : brackets.unexpected;
      }
      if (color === undefined) continue;
      const at = token.offset + i;
      if (mark && at > runStart) ranges.push(mark.range(runStart, at));
      ranges.push(styleMark(color, style).range(at, at + 1));
      runStart = at + 1;
    }
    const end = token.offset + token.content.length;
    if (mark && end > runStart) ranges.push(mark.range(runStart, end));
  }
  return Decoration.set(ranges, true);
}

/** Set once the shared highlighter has loaded, so later blocks color on their first paint. */
let loadedHighlighter: Highlighter | null = null;

/** Colors a code block's text with Shiki's tokens for `lang`. */
function shikiHighlight(lang: string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.highlight();
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        this.decorations = this.decorations.map(update.changes);
        this.highlight();
      }

      private highlight() {
        if (loadedHighlighter) {
          this.decorations = shikiDecorations(
            loadedHighlighter,
            lang,
            this.view.state.doc.toString(),
          );
          return;
        }
        void getHighlighter().then((highlighter) => {
          loadedHighlighter = highlighter;
          if (this.destroyed) return;
          this.decorations = shikiDecorations(highlighter, lang, this.view.state.doc.toString());
          // An empty transaction makes the view read the new decorations.
          this.view.dispatch({});
        });
      }

      destroy() {
        this.destroyed = true;
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [NO_CODEMIRROR_COLORS, plugin];
}

/** CodeMirror's language, colored by Shiki when it has the grammar, else by the fallback style. */
function withShikiColors(language: LanguageDescription): LanguageDescription {
  const shikiId = shikiIdFor(language);
  return LanguageDescription.of({
    name: language.name,
    alias: language.alias,
    extensions: language.extensions,
    filename: language.filename,
    load: async () => {
      const support = await language.load();
      const colors = shikiId ? shikiHighlight(shikiId) : syntaxHighlighting(FALLBACK_HIGHLIGHT);
      return new LanguageSupport(support.language, [support.support, colors]);
    },
  });
}

/** A language only Shiki has: plain editing, Shiki's colors. */
function shikiOnly(info: (typeof SHIKI_LANGUAGES)[number]): LanguageDescription {
  return LanguageDescription.of({
    name: info.name,
    alias: [info.id, ...(info.aliases ?? [])],
    load: async () => new LanguageSupport(PLAIN_LANGUAGE, shikiHighlight(info.id)),
  });
}

/** The code block languages, for Crepe's CodeMirror feature (`languages`). */
export function codeBlockLanguages(): LanguageDescription[] {
  const wrapped = codeMirrorLanguages.map(withShikiColors);
  const covered = new Set(codeMirrorLanguages.map(shikiIdFor));
  const extra = SHIKI_LANGUAGES.filter((info) => !covered.has(info.id)).map(shikiOnly);
  return [...wrapped, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}
