import { afterEach, describe, expect, jest, test } from "bun:test";

import { LanguageDescription } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

import { getHighlighter } from "@/lib/highlighter";
import type { LoxelTheme } from "@/lib/loxel-theme";
import { syntaxTextmateTheme, syntaxThemeName, useSyntaxThemeStore } from "@/lib/syntax-theme";
import { useUIStore } from "@/store/ui";

import { codeBlockLanguages } from "./code-block-highlight";

const languages = codeBlockLanguages();

describe("codeBlockLanguages", () => {
  test("keeps CodeMirror's languages and adds the ones only Shiki has", () => {
    const names = languages.map((language) => language.name);
    expect(new Set(names).size).toBe(names.length);
    expect(LanguageDescription.matchLanguageName(languages, "bash")?.name).toBe("Shell");
    expect(LanguageDescription.matchLanguageName(languages, "terraform")).toBeDefined();
  });

  test("names multi-word Shiki-only languages by id, so the picker writes a one-word fence", () => {
    expect(LanguageDescription.matchLanguageName(languages, "jsonc")?.name).toBe("jsonc");
    expect(LanguageDescription.matchLanguageName(languages, "razor")?.name).toBe("razor");
  });
});

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Renders `code` as a block of `lang` and returns each character's computed inline color. */
async function colors(lang: string, code: string): Promise<{ char: string; color: string }[]> {
  const support = await LanguageDescription.matchLanguageName(languages, lang)!.load();
  view = new EditorView({ doc: code, extensions: [support], parent: document.body });
  // The block colors once the shared highlighter is ready; this resolves after its own callback.
  await getHighlighter();
  const result: { char: string; color: string }[] = [];
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const color = node.parentElement?.style.color ?? "";
    for (const char of node.textContent ?? "") result.push({ char, color });
  }
  return result;
}

const colorOf = (chars: { char: string; color: string }[], char: string, nth = 0) =>
  chars.filter((c) => c.char === char)[nth]?.color;

describe("code block colors", () => {
  test("shifts colors on an edit and re-tokenizes once typing pauses", async () => {
    await colors("typescript", "x;");
    jest.useFakeTimers();
    try {
      view!.dispatch({ changes: { from: 0, insert: "const " } });
      const keyword = () =>
        [...view!.contentDOM.querySelectorAll("span")].find((span) => span.textContent === "const");
      // Typed text is plain until the block is tokenized again, after the pause.
      expect(keyword()).toBeUndefined();
      jest.advanceTimersByTime(1000);
      expect(keyword()?.style.color).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test("recolors when the app theme changes", async () => {
    const initial = useUIStore.getState().darkMode;
    try {
      useUIStore.setState({ darkMode: true });
      const dark = colorOf(await colors("typescript", "const a = 1;"), "c");
      useUIStore.setState({ darkMode: false });
      const keyword = [...view!.contentDOM.querySelectorAll("span")].find(
        (span) => span.textContent === "const",
      );
      expect(keyword?.style.color).toBeTruthy();
      expect(keyword?.style.color).not.toBe(dark);
    } finally {
      useUIStore.setState({ darkMode: initial });
    }
  });

  test("colors mermaid blocks with Shiki's mermaid grammar in both themes", async () => {
    expect(LanguageDescription.matchLanguageName(languages, "mmd")?.name).toBe("Mermaid");
    const initial = useUIStore.getState().darkMode;
    const code = "flowchart LR\n  A[Start] --> B";
    const tokens = (chars: { char: string; color: string }[]) => ({
      keyword: colorOf(chars, "f"),
      label: colorOf(chars, "S"),
      node: colorOf(chars, "A"),
    });
    try {
      useUIStore.setState({ darkMode: false });
      const light = tokens(await colors("mermaid", code));
      view?.destroy();
      useUIStore.setState({ darkMode: true });
      const dark = tokens(await colors("mermaid", code));
      for (const theme of [light, dark]) {
        expect(theme.keyword).toBeTruthy();
        expect(theme.label).toBeTruthy();
        expect(new Set([theme.keyword, theme.label, theme.node]).size).toBe(3);
      }
      expect(dark.keyword).not.toBe(light.keyword);
    } finally {
      useUIStore.setState({ darkMode: initial });
    }
  });

  test("colors tokens with the editor theme", async () => {
    const chars = await colors("typescript", 'const a = "x";');
    expect(colorOf(chars, "c")).not.toBe("");
    // The string and the keyword get different theme colors.
    expect(colorOf(chars, "x")).not.toBe(colorOf(chars, "c"));
  });

  test("cycles bracket colors by depth across bracket kinds, like Monaco", async () => {
    const chars = await colors("typescript", "call(a, [b, { c }]);");
    const [gold, orchid, blue] = [colorOf(chars, "("), colorOf(chars, "["), colorOf(chars, "{")];
    expect(new Set([gold, orchid, blue]).size).toBe(3);
    expect(colorOf(chars, "}")).toBe(blue);
    expect(colorOf(chars, "]")).toBe(orchid);
    expect(colorOf(chars, ")")).toBe(gold);
  });

  test("leaves brackets in strings and comments as text", async () => {
    const chars = await colors("typescript", 'f("(x)"); // (y)');
    const call = colorOf(chars, "(", 0);
    expect(colorOf(chars, "(", 1)).toBe(colorOf(chars, "x"));
    expect(colorOf(chars, "(", 1)).not.toBe(call);
    expect(colorOf(chars, "(", 2)).toBe(colorOf(chars, "y"));
  });

  test("keeps brackets in strings as text after a theme's string color changes", async () => {
    const highlighter = await getHighlighter();
    const initial = { ...useSyntaxThemeStore.getState(), darkMode: useUIStore.getState().darkMode };
    const theme = (string: string): LoxelTheme => ({
      id: "custom:test",
      name: "Test",
      base: "dark",
      colors: {},
      terminal: {},
      syntax: { string },
    });
    try {
      useUIStore.setState({ darkMode: true });
      await highlighter.loadTheme(syntaxTextmateTheme(theme("#ff00aa"), (c) => c));
      useSyntaxThemeStore.setState({ dark: syntaxThemeName(theme("#ff00aa")), revision: 1 });
      await colors("typescript", 'f("(x)");');
      // The same name with new colors, as editor-themes.ts reloads an edited theme.
      await highlighter.loadTheme(syntaxTextmateTheme(theme("#00aaff"), (c) => c));
      useSyntaxThemeStore.setState({ revision: 2 });
      const chars = [...view!.contentDOM.querySelectorAll("span")].flatMap((span) =>
        (span.textContent ?? "").split("").map((char) => ({ char, color: span.style.color })),
      );
      expect(colorOf(chars, "(", 1)).toBe(colorOf(chars, "x"));
      expect(colorOf(chars, "(", 1)).not.toBe(colorOf(chars, "(", 0));
    } finally {
      const { darkMode, ...names } = initial;
      useSyntaxThemeStore.setState(names);
      useUIStore.setState({ darkMode });
    }
  });

  test("declares every color variable the fallback palette reads", async () => {
    // Liquid has a CodeMirror grammar but no Shiki one, so it takes the fallback palette.
    const support = await LanguageDescription.matchLanguageName(languages, "liquid")!.load();
    view = new EditorView({ doc: '<a href="x">', extensions: [support], parent: document.body });
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent).join("");
    const read = new Set([...css.matchAll(/var\((--md-code-[\w-]+)\)/g)].map((m) => m[1]));
    const declared = new Set([...css.matchAll(/(--md-code-[\w-]+)\s*:/g)].map((m) => m[1]));
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((name) => !declared.has(name))).toEqual([]);
  });

  test("marks a closing bracket with no opener", async () => {
    const chars = await colors("typescript", "a);");
    expect(colorOf(chars, ")")).toBe("rgba(255, 18, 18, 0.8)");
  });
});
