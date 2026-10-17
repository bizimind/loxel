import { afterEach, describe, expect, test } from "bun:test";

import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";

import type { MarkdownOutputSettings } from "@/lib/formatting-model";
import { DEFAULT_MARKDOWN_OUTPUT_SETTINGS } from "@/lib/formatting-model";

import { buildRemarkStringifyOptions } from "./markdown-stringify-options";

// Every block marker deliberately differs from the defaults so the test proves the settings
// win over what was parsed from the source.
const SOURCE = [
  "Title",
  "=====",
  "",
  "+ one",
  "+ two",
  "",
  "1) first",
  "1) second",
  "",
  "*em* __strong__",
  "",
  "~~~",
  "code",
  "~~~",
  "",
  "___",
  "",
].join("\n");

const editors: Editor[] = [];

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
});

/** Round-trip markdown through a headless Milkdown editor configured like MarkdownEditor. */
async function roundTrip(options: Partial<MarkdownOutputSettings>): Promise<string> {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, SOURCE);
      ctx.set(
        remarkStringifyOptionsCtx,
        buildRemarkStringifyOptions(ctx.get(remarkStringifyOptionsCtx), {
          ...DEFAULT_MARKDOWN_OUTPUT_SETTINGS,
          ...options,
        }),
      );
    })
    .use(commonmark)
    .create();
  editors.push(editor);
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
}

describe("buildRemarkStringifyOptions through Milkdown", () => {
  test("defaults rewrite block markers to Prettier/oxfmt style", async () => {
    expect(await roundTrip({})).toBe(
      [
        "# Title",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        // Emphasis/strong are not configurable: Milkdown keeps the marker parsed from the source.
        "*em* __strong__",
        "",
        "```",
        "code",
        "```",
        "",
        "---",
        "",
      ].join("\n"),
    );
  });

  test("list, fence, rule, and heading options apply", async () => {
    const out = await roundTrip({
      bullet: "*",
      bulletOrdered: ")",
      incrementListMarker: false,
      fence: "~",
      rule: "*",
      listItemIndent: "tab",
      setext: true,
    });
    expect(out).toStartWith("Title\n=====\n");
    expect(out).toContain("\n*   one\n*   two\n");
    expect(out).toContain("\n1)  first\n1)  second\n");
    expect(out).toContain("\n~~~\ncode\n~~~\n");
    expect(out).toContain("\n***\n");
  });
});
