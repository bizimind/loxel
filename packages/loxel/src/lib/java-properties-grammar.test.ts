import { describe, expect, test } from "bun:test";

import { createHighlighter } from "shiki";

import { JAVA_PROPERTIES_GRAMMAR } from "./java-properties-grammar";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: [JAVA_PROPERTIES_GRAMMAR],
});

/** The text of each token on each line, with the most specific TextMate scope it got. */
function scopes(code: string): [string, string][][] {
  const { tokens } = highlighter.codeToTokens(code, {
    lang: JAVA_PROPERTIES_GRAMMAR.name as "properties",
    theme: "github-dark",
    includeExplanation: true,
  });
  return tokens.map((line) =>
    line.flatMap((token) =>
      (token.explanation ?? []).map(({ content, scopes: stack }): [string, string] => [
        content,
        stack.at(-1)?.scopeName.replace(/\.java-properties$/, "") ?? "",
      ]),
    ),
  );
}

describe("Java properties grammar", () => {
  test.each(["# a comment", "! a comment", "  ! it's indented"])("%s is a comment", (line) => {
    expect(scopes(line)).toEqual([[[line, "comment.line"]]]);
  });

  test.each([
    ["key=value", "="],
    ["key:value", ":"],
  ])("splits %s at its separator", (line, separator) => {
    expect(scopes(line)).toEqual([
      [
        ["key", "entity.name.tag"],
        [separator, "punctuation.separator.key-value"],
        ["value", "string.unquoted"],
      ],
    ]);
  });

  test("keeps a whole dotted key and a value containing separators together", () => {
    expect(scopes("org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8")).toEqual([
      [
        ["org.gradle.jvmargs", "entity.name.tag"],
        ["=", "punctuation.separator.key-value"],
        ["-Xmx2g -Dfile.encoding=UTF-8", "string.unquoted"],
      ],
    ]);
  });

  test.each(["path=a;b;c", "url=http://x/y#frag", "message=it's"])(
    "%s has no comment or string running out of its value",
    (line) => {
      const [first, next] = scopes(`${line}\nnext=1`);
      expect(first?.[2]).toEqual([line.slice(line.indexOf("=") + 1), "string.unquoted"]);
      expect(next?.[0]).toEqual(["next", "entity.name.tag"]);
    },
  );

  test.each(["key=", "key =  ", "flag", "key=\r"])("%j ends at its line", (line) => {
    for (const code of [`${line}\nnext=1`, `${line}\n# comment\nnext=1`]) {
      const tokens = scopes(code);
      expect(tokens.at(-1)?.[0]).toEqual(["next", "entity.name.tag"]);
    }
  });

  test("scopes a whole unicode escape", () => {
    expect(scopes("key=a\\u00e9b")[0]?.slice(2)).toEqual([
      ["a", "string.unquoted"],
      ["\\u00e9", "constant.character.escape"],
      ["b", "string.unquoted"],
    ]);
  });

  test("reads an escaped separator as part of the key", () => {
    expect(scopes("a\\:b=c")[0]?.[0]).toEqual(["a\\:b", "entity.name.tag"]);
  });

  test("continues a value over a trailing backslash", () => {
    const [, second, third] = scopes("key=one \\\n  two\nnext=1");
    expect(second).toEqual([["  two", "string.unquoted"]]);
    expect(third?.[0]).toEqual(["next", "entity.name.tag"]);
  });

  test("an escaped backslash at the end of a line does not continue the value", () => {
    expect(scopes("key=C:\\\\\nnext=1")[1]?.[0]).toEqual(["next", "entity.name.tag"]);
  });
});
