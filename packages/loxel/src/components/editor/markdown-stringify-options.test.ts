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
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import type { MarkdownOutputSettings } from "@/lib/formatting-model";
import { DEFAULT_MARKDOWN_OUTPUT_SETTINGS } from "@/lib/formatting-model";

import {
  buildRemarkStringifyOptions,
  remarkForgetSourceMarkers,
} from "./markdown-stringify-options";

// Every marker deliberately differs from the defaults so the test proves the settings win
// over what was parsed from the source (Milkdown remembers source markers per node).
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
async function roundTrip({
  source = SOURCE,
  ...options
}: Partial<MarkdownOutputSettings> & { source?: string }): Promise<string> {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, source);
      ctx.set(
        remarkStringifyOptionsCtx,
        buildRemarkStringifyOptions(ctx.get(remarkStringifyOptionsCtx), {
          ...DEFAULT_MARKDOWN_OUTPUT_SETTINGS,
          ...options,
        }),
      );
    })
    .use(commonmark)
    .use(remarkForgetSourceMarkers)
    .create();
  editors.push(editor);
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
}

describe("buildRemarkStringifyOptions through Milkdown", () => {
  test("defaults rewrite every source marker to Prettier/oxfmt style", async () => {
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
        "_em_ **strong**",
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

  test("emphasis and strong follow the settings, not the parsed marker", async () => {
    const out = await roundTrip({ emphasis: "*", strong: "_" });
    expect(out).toContain("*em* __strong__");
    const swapped = await roundTrip({ emphasis: "_", strong: "*" });
    expect(swapped).toContain("_em_ **strong**");
  });

  test("intra-word emphasis/strong fall back to * instead of character references", async () => {
    const intraWord = ["a*b*c", "A file*name*here.", "*em*text", "a**b**c", ""].join("\n");
    for (const markers of [
      { emphasis: "_", strong: "_" },
      { emphasis: "*", strong: "*" },
    ] as const) {
      const out = await roundTrip({ ...markers, source: intraWord });
      expect(out).toBe(intraWord);
      expect(out).not.toContain("&#");
    }
  });

  test("whitespace-delimited emphasis keeps the configured marker", async () => {
    const out = await roundTrip({ emphasis: "_", strong: "_", source: "a *b* c **d** (*e*)\n" });
    expect(out).toBe("a _b_ c __d__ (_e_)\n");
  });

  test("adjacent same-style runs merge instead of fusing their markers", async () => {
    const out = await roundTrip({
      emphasis: "_",
      strong: "*",
      source: "*foo*_bar_\n\n**foo**__bar__\n",
    });
    expect(out).toBe("_foobar_\n\n**foobar**\n");
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

describe("buildRemarkStringifyOptions handlers on a bare mdast tree", () => {
  const adjacentRuns: Root = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "emphasis", children: [{ type: "text", value: "foo" }] },
          { type: "emphasis", children: [{ type: "text", value: "bar" }] },
          { type: "text", value: " " },
          { type: "strong", children: [{ type: "text", value: "foo" }] },
          { type: "strong", children: [{ type: "text", value: "bar" }] },
        ],
      },
    ],
  };

  test.each([
    { emphasis: "_", strong: "*" },
    { emphasis: "*", strong: "_" },
  ] as const)("adjacent runs keep distinct delimiters with %o", (markers) => {
    const processor = unified().use(
      remarkStringify,
      buildRemarkStringifyOptions({}, { ...DEFAULT_MARKDOWN_OUTPUT_SETTINGS, ...markers }),
    );
    const out = processor.stringify(adjacentRuns);
    expect(out).not.toContain("&#");
    const reparsed = unified().use(remarkParse).parse(out);
    const paragraph = reparsed.children[0];
    if (paragraph?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(paragraph.children.map((child) => child.type)).toEqual([
      "emphasis",
      "emphasis",
      "text",
      "strong",
      "strong",
    ]);
  });
});
