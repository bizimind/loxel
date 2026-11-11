import { afterEach, describe, expect, jest, test } from "bun:test";

import { LanguageDescription } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

import { getHighlighter } from "@/lib/highlighter";

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

  test("marks a closing bracket with no opener", async () => {
    const chars = await colors("typescript", "a);");
    expect(colorOf(chars, ")")).toBe("rgba(255, 18, 18, 0.8)");
  });
});
