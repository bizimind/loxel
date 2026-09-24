import { describe, expect, test } from "bun:test";

import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import type { MarkdownOutputSettings } from "./formatting-model";
import {
  DEFAULT_MARKDOWN_OUTPUT_SETTINGS,
  MARKDOWN_OUTPUT_CHOICES,
  parseMarkdownOutputSettings,
} from "./formatting-model";

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

function serialize(options: Partial<MarkdownOutputSettings>): string {
  return unified()
    .use(remarkParse)
    .use(remarkStringify, { ...DEFAULT_MARKDOWN_OUTPUT_SETTINGS, ...options })
    .processSync(SOURCE)
    .toString();
}

describe("markdown output options against installed remark-stringify", () => {
  test("defaults match Prettier/oxfmt output", () => {
    expect(serialize({})).toBe(
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

  test.each([...MARKDOWN_OUTPUT_CHOICES.bullet])("bullet %s", (bullet) => {
    expect(serialize({ bullet })).toContain(`\n${bullet} one\n${bullet} two\n`);
  });

  test.each([...MARKDOWN_OUTPUT_CHOICES.bulletOrdered])("bulletOrdered %s", (bulletOrdered) => {
    expect(serialize({ bulletOrdered })).toContain(
      `\n1${bulletOrdered} first\n2${bulletOrdered} second\n`,
    );
  });

  test("incrementListMarker false repeats the first number", () => {
    expect(serialize({ incrementListMarker: false })).toContain("\n1. first\n1. second\n");
  });

  test.each([...MARKDOWN_OUTPUT_CHOICES.emphasis])("emphasis %s", (emphasis) => {
    expect(serialize({ emphasis })).toContain(`\n${emphasis}em${emphasis} `);
  });

  test.each([...MARKDOWN_OUTPUT_CHOICES.strong])("strong %s", (strong) => {
    expect(serialize({ strong })).toContain(` ${strong}${strong}strong${strong}${strong}\n`);
  });

  test.each([...MARKDOWN_OUTPUT_CHOICES.fence])("fence %s", (fence) => {
    const fenceLine = fence.repeat(3);
    expect(serialize({ fence })).toContain(`\n${fenceLine}\ncode\n${fenceLine}\n`);
  });

  test.each([...MARKDOWN_OUTPUT_CHOICES.rule])("rule %s", (rule) => {
    expect(serialize({ rule })).toContain(`\n${rule}${rule}${rule}\n`);
  });

  test("listItemIndent tab pads content to the next tab stop", () => {
    expect(serialize({ listItemIndent: "tab" })).toContain("\n-   one\n-   two\n");
  });

  test("setext true underlines h1", () => {
    expect(serialize({ setext: true })).toStartWith("Title\n=====\n");
  });
});

describe("parseMarkdownOutputSettings", () => {
  test("returns defaults for non-object input", () => {
    expect(parseMarkdownOutputSettings(undefined)).toEqual(DEFAULT_MARKDOWN_OUTPUT_SETTINGS);
    expect(parseMarkdownOutputSettings("nope")).toEqual(DEFAULT_MARKDOWN_OUTPUT_SETTINGS);
  });

  test("keeps valid values and replaces invalid ones", () => {
    const parsed = parseMarkdownOutputSettings({
      bullet: "*",
      bulletOrdered: "?",
      setext: true,
      incrementListMarker: "yes",
      listItemIndent: "tab",
    });
    expect(parsed).toEqual({
      ...DEFAULT_MARKDOWN_OUTPUT_SETTINGS,
      bullet: "*",
      setext: true,
      listItemIndent: "tab",
    });
  });
});
