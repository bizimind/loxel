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
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type Highlighter, bundledLanguagesInfo } from "shiki";

import { frontendLog } from "@/lib/frontend-logger";
import { BUNDLED_LANGUAGES, getHighlighter } from "@/lib/highlighter";
import { getMonacoThemeName } from "@/lib/monaco-theme";
import { useSyntaxThemeStore } from "@/lib/syntax-theme";
import { useUIStore } from "@/store/ui";

const log = frontendLog.child("ui");

/**
 * Code-block token colors as [dark, light]: loxel's JetBrains dark palette, and IntelliJ Light to
 * match the light editor theme. They reach the highlight style through CSS variables, so a code
 * block follows the app theme without being rebuilt.
 */
const CODE_COLORS = {
  keyword: ["#cf8e6d", "#1f3a93"],
  operator: ["#cf8e6d", "#1e1f22"],
  name: ["#bcbec4", "#1e1f22"],
  property: ["#c77dbb", "#85358C"],
  function: ["#56a8f5", "#156275"],
  type: ["#2fbaa3", "#0a6b72"],
  string: ["#6aab73", "#1f7a2b"],
  number: ["#2aacb8", "#a85400"],
  comment: ["#7a7e85", "#747882"],
  meta: ["#bbb529", "#9e880d"],
  tag: ["#e8bf6a", "#1f3a93"],
  attribute: ["#bababa", "#174ad4"],
  attributeValue: ["#6a8759", "#1f7a2b"],
  link: ["#56a8f5", "#2a5dd8"],
} satisfies Record<string, [dark: string, light: string]>;

type CodeColor = keyof typeof CODE_COLORS;

/**
 * The variable a token color is read from, lowercased: `style-mod` kebab-cases the property names
 * it emits (`attributeValue` would be declared as `attribute-value`) but not the `var()` values.
 */
const codeVar = (name: string) => `--md-code-${name.toLowerCase()}`;

const codeColor = (name: CodeColor) => `var(${codeVar(name)})`;

function codeColorVars(index: 0 | 1): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CODE_COLORS).map(([name, colors]) => [codeVar(name), colors[index]]),
  );
}

/** CodeMirror theme for code blocks: the token colors of the light root, or of a `.dark` one. */
const codeColorTheme = EditorView.theme({ "&": codeColorVars(1), ".dark &": codeColorVars(0) });

/** For languages Shiki doesn't load: CodeMirror's parse, in the colors above. */
const FALLBACK_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: codeColor("keyword") },
  { tag: tags.operator, color: codeColor("operator") },
  { tag: tags.name, color: codeColor("name") },
  { tag: tags.variableName, color: codeColor("name") },
  { tag: tags.propertyName, color: codeColor("property") },
  { tag: tags.function(tags.variableName), color: codeColor("function") },
  { tag: tags.function(tags.propertyName), color: codeColor("function") },
  { tag: tags.definition(tags.variableName), color: codeColor("name") },
  { tag: tags.typeName, color: codeColor("type") },
  { tag: tags.className, color: codeColor("type") },
  { tag: tags.string, color: codeColor("string") },
  { tag: tags.special(tags.string), color: codeColor("string") },
  { tag: tags.number, color: codeColor("number") },
  { tag: tags.bool, color: codeColor("keyword") },
  { tag: tags.null, color: codeColor("keyword") },
  { tag: tags.comment, color: codeColor("comment"), fontStyle: "italic" },
  { tag: tags.lineComment, color: codeColor("comment"), fontStyle: "italic" },
  { tag: tags.blockComment, color: codeColor("comment"), fontStyle: "italic" },
  { tag: tags.meta, color: codeColor("meta") },
  { tag: tags.regexp, color: codeColor("string") },
  { tag: tags.tagName, color: codeColor("tag") },
  { tag: tags.attributeName, color: codeColor("attribute") },
  { tag: tags.attributeValue, color: codeColor("attributeValue") },
  { tag: tags.heading, color: codeColor("name"), fontWeight: "bold" },
  { tag: tags.link, color: codeColor("link"), textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
]);

/** The fallback colors and the variables they read, for the app theme. */
const FALLBACK_COLORS: Extension = [syntaxHighlighting(FALLBACK_HIGHLIGHT), codeColorTheme];

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
 * Monaco's bracket pair colors (its defaults, which Loxel's themes don't override), by the theme's
 * type as Monaco picks them: a cycle by nesting depth across all bracket kinds, and a color for a
 * closer with no opener.
 */
const BRACKET_COLORS = {
  dark: { levels: ["#FFD700", "#DA70D6", "#179FFF"], unexpected: "rgba(255, 18, 18, 0.8)" },
  light: { levels: ["#0431FA", "#319331", "#7B3814"], unexpected: "rgba(255, 18, 18, 0.8)" },
} as const;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const STRIKETHROUGH = 8;

/** Shiki's font style bits for a theme rule's `fontStyle` string. */
function fontStyleBits(fontStyle: string | undefined): number {
  const words = new Set((fontStyle ?? "").split(/[\s,]+/));
  return (
    (words.has("italic") ? ITALIC : 0) |
    (words.has("bold") ? BOLD : 0) |
    (words.has("underline") ? UNDERLINE : 0) |
    (words.has("strikethrough") ? STRIKETHROUGH : 0)
  );
}

/** A color as `@shikijs/monaco` normalizes it: lowercase hex without `#`, short forms expanded. */
function normalizeColor(color: string): string {
  const hex = color.replace(/^#/, "").toLowerCase();
  return hex.length === 3 || hex.length === 4 ? hex.replaceAll(/./g, "$&$&") : hex;
}

const colorStyleKey = (color: string, style: number) => `${normalizeColor(color)}|${style}`;

/**
 * Per theme name, the scope for each color and style, and the revision it was built at: a custom
 * theme's colors change under the same name, with a new `useSyntaxThemeStore` revision.
 */
const scopesByTheme = new Map<string, { revision: number; scopes: Map<string, string> }>();

/**
 * Whether Monaco treats a token of this color and style as a string, comment or regex, whose
 * brackets it leaves uncolored. Monaco sees the scope of the first theme rule with the token's
 * color and style (that's the scope `@shikijs/monaco` hands it), classified by Monaco's
 * `STANDARD_TOKEN_TYPE_REGEXP`; this mirrors both so blocks color the same brackets.
 */
function isTextToken(highlighter: Highlighter, themeName: string, color: string, style: number) {
  const { revision } = useSyntaxThemeStore.getState();
  const cached = scopesByTheme.get(themeName);
  let scopes = cached?.revision === revision ? cached.scopes : undefined;
  if (!scopes) {
    scopes = new Map();
    for (const rule of highlighter.getTheme(themeName).settings) {
      const foreground = rule.settings.foreground;
      const scope = Array.isArray(rule.scope) ? rule.scope[0] : rule.scope;
      // `@shikijs/monaco` turns each scope into a Monaco rule, so a rule without one maps nothing.
      if (!foreground || !scope) continue;
      const key = colorStyleKey(foreground, fontStyleBits(rule.settings.fontStyle));
      if (!scopes.has(key)) scopes.set(key, scope);
    }
    scopesByTheme.set(themeName, { revision, scopes });
  }
  const scope = scopes.get(colorStyleKey(color, style)) ?? "";
  return /\b(comment|string|regex|regexp)\b/.test(scope);
}

function shikiDecorations(highlighter: Highlighter, lang: string, text: string): DecorationSet {
  const themeName = getMonacoThemeName(useUIStore.getState().darkMode);
  const theme = highlighter.getTheme(themeName);
  const brackets = theme.type === "light" ? BRACKET_COLORS.light : BRACKET_COLORS.dark;
  const lines = highlighter.codeToTokensBase(text, {
    lang: lang as Parameters<Highlighter["codeToTokensBase"]>[1]["lang"],
    theme,
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

/**
 * How long after the last edit a block is re-tokenized. Tokenizing is synchronous and grows with
 * the block (tens of milliseconds for a few hundred lines), so edits only shift the existing colors
 * and the block is colored again once typing pauses.
 */
const RETOKENIZE_DELAY_MS = 150;

/** Set once the shared highlighter has loaded, so later blocks color on their first paint. */
let loadedHighlighter: Highlighter | null = null;
let loadFailureLogged = false;

/** Colors a code block's text with Shiki's tokens for `lang`. */
function shikiHighlight(lang: string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private destroyed = false;
      private timer: ReturnType<typeof setTimeout> | undefined;
      /** Recolors the block for the new theme when the mode or a theme's syntax colors change. */
      private readonly unsubscribeMode = useUIStore.subscribe((state, prev) => {
        if (state.darkMode !== prev.darkMode) this.repaint();
      });
      private readonly unsubscribeSyntax = useSyntaxThemeStore.subscribe(() => this.repaint());

      constructor(private readonly view: EditorView) {
        if (loadedHighlighter) {
          this.decorations = this.tokenize(loadedHighlighter);
          return;
        }
        getHighlighter()
          .then((highlighter) => {
            loadedHighlighter = highlighter;
            this.repaint();
          })
          .catch((error: unknown) => {
            if (loadFailureLogged) return;
            loadFailureLogged = true;
            log.error("Code block highlighter failed to load; blocks stay uncolored", { error });
          });
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        this.decorations = this.decorations.map(update.changes);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.repaint(), RETOKENIZE_DELAY_MS);
      }

      private tokenize(highlighter: Highlighter): DecorationSet {
        return shikiDecorations(highlighter, lang, this.view.state.doc.toString());
      }

      /** Re-tokenizes outside a view update and makes the view read the new decorations. */
      private repaint() {
        if (this.destroyed || !loadedHighlighter) return;
        this.decorations = this.tokenize(loadedHighlighter);
        this.view.dispatch({});
      }

      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
        this.unsubscribeMode();
        this.unsubscribeSyntax();
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
      const colors = shikiId ? shikiHighlight(shikiId) : FALLBACK_COLORS;
      return new LanguageSupport(support.language, [support.support, colors]);
    },
  });
}

/**
 * A language only Shiki has: plain editing, Shiki's colors. The picker writes the name as the
 * fence's info string, which ends at the first space, so multi-word names use the id.
 */
function shikiOnly(info: (typeof SHIKI_LANGUAGES)[number]): LanguageDescription {
  return LanguageDescription.of({
    name: /\s/.test(info.name) ? info.id : info.name,
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
