import { beforeAll, describe, expect, test } from "bun:test";

import * as monaco from "monaco-editor";

import { registerPipRequirementsLanguage } from "./pip-requirements-monarch";

/** Each line as `text:token` pairs, whitespace-only tokens dropped, postfix stripped. */
function tokenize(source: string): string[][] {
  const lines = source.split("\n");
  return monaco.editor.tokenize(source, "pip-requirements").map((tokens, lineIndex) => {
    const line = lines[lineIndex] ?? "";
    return tokens
      .map((token, i) => ({
        text: line.slice(token.offset, tokens[i + 1]?.offset ?? line.length),
        type: token.type.replace(/\.pip-requirements$/, ""),
      }))
      .filter(({ text }) => text.trim() !== "")
      .map(({ text, type }) => `${text.trim()}:${type}`);
  });
}

describe("pip-requirements tokenizer", () => {
  beforeAll(() => {
    registerPipRequirementsLanguage();
  });

  test("requirement with extras, specifiers, marker and comment", () => {
    expect(tokenize(`requests[socks]>=2.31,<3 ; python_version < "3.12"  # http`)).toEqual([
      [
        "requests:entity.name.type",
        "[:punctuation.section",
        "socks:entity.other.attribute-name",
        "]:punctuation.section",
        ">=:keyword.operator",
        "2.31:constant.numeric",
        ",:punctuation.separator",
        "<:keyword.operator",
        "3:constant.numeric",
        ";:punctuation.separator",
        "python_version:support.variable",
        "<:keyword.operator",
        `"3.12":string`,
        "# http:comment",
      ],
    ]);
  });

  test("options, comments, URLs and per-line state reset", () => {
    expect(
      tokenize(
        [
          "# pinned",
          "-r base.txt",
          "--index-url https://pypi.org/simple",
          "pkg @ https://example.com/pkg.whl#sha256=abc",
          "-e ./local",
          "django==5.0",
        ].join("\n"),
      ),
    ).toEqual([
      ["# pinned:comment"],
      ["-r:keyword", "base.txt:string"],
      ["--index-url:keyword", "https://pypi.org/simple:string"],
      [
        "pkg:entity.name.type",
        "@:keyword.operator",
        "https://example.com/pkg.whl#sha256=abc:string",
      ],
      ["-e:keyword", "./local:string"],
      ["django:entity.name.type", "==:keyword.operator", "5.0:constant.numeric"],
    ]);
  });
});
