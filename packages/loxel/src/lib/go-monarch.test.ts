import { beforeAll, describe, expect, test } from "bun:test";

import * as monaco from "monaco-editor";

import { registerGoProjectFileLanguages } from "./go-monarch";

/** Each line as `text:token` pairs, whitespace-only tokens dropped, postfix stripped. */
function tokenize(source: string, language: string): string[][] {
  const lines = source.split("\n");
  return monaco.editor.tokenize(source, language).map((tokens, lineIndex) => {
    const line = lines[lineIndex] ?? "";
    return tokens
      .map((token, i) => ({
        text: line.slice(token.offset, tokens[i + 1]?.offset ?? line.length),
        type: token.type.replace(/\.go(?:mod|sum)$/, ""),
      }))
      .filter(({ text }) => text.trim() !== "")
      .map(({ text, type }) => `${text.trim()}:${type}`);
  });
}

beforeAll(() => {
  registerGoProjectFileLanguages();
});

describe.each(["go.mod", "go.work"])("%s tokenizer", (language) => {
  test.each([
    ["module github.com/a/b/v2", ["module:keyword", "github.com/a/b/v2:entity.name.type"]],
    ["go 1.26.0", ["go:keyword", "1.26.0:constant.numeric"]],
    ["go 1.23rc1", ["go:keyword", "1.23rc1:constant.numeric"]],
    ["toolchain go1.26.0", ["toolchain:keyword", "go1.26.0:constant.numeric"]],
    ["toolchain default", ["toolchain:keyword", "default:entity.name.type"]],
    [
      "godebug panicnil=1",
      ["godebug:keyword", "panicnil:variable", "=:keyword.operator", "1:string"],
    ],
    [
      "require a.b/c v1.2.3 // indirect",
      [
        "require:keyword",
        "a.b/c:entity.name.type",
        "v1.2.3:constant.numeric",
        "// indirect:comment",
      ],
    ],
    [
      "replace a.b/c v1.0.0 => ../c",
      [
        "replace:keyword",
        "a.b/c:entity.name.type",
        "v1.0.0:constant.numeric",
        "=>:keyword.operator",
        "../c:string",
      ],
    ],
    [
      "replace a.b/c => d.e/f v0.0.0-20210328193216-ff5ff6dc229b",
      [
        "replace:keyword",
        "a.b/c:entity.name.type",
        "=>:keyword.operator",
        "d.e/f:entity.name.type",
        "v0.0.0-20210328193216-ff5ff6dc229b:constant.numeric",
      ],
    ],
    [
      "exclude a.b/c v2.0.0+incompatible",
      ["exclude:keyword", "a.b/c:entity.name.type", "v2.0.0+incompatible:constant.numeric"],
    ],
    [
      "retract [v1.0.0, v1.1.0-rc.1] // broken",
      [
        "retract:keyword",
        "[:punctuation.section",
        "v1.0.0:constant.numeric",
        ",:punctuation.separator",
        "v1.1.0-rc.1:constant.numeric",
        "]:punctuation.section",
        "// broken:comment",
      ],
    ],
    ["tool a.b/cmd/x", ["tool:keyword", "a.b/cmd/x:entity.name.type"]],
    ["use ./tools", ["use:keyword", "./tools:string"]],
    ["use .", ["use:keyword", ".:string"]],
    ["ignore ./node_modules", ["ignore:keyword", "./node_modules:string"]],
    ['require "a.b/c" `v1.0.0`', ["require:keyword", '"a.b/c":string', "`v1.0.0`:string"]],
    ["// Deprecated: use d.e/f", ["// Deprecated: use d.e/f:comment"]],
    ["module a//b", ["module:keyword", "a:entity.name.type", "//b:comment"]],
    [
      "require a v1.0.0//x",
      ["require:keyword", "a:entity.name.type", "v1.0.0:constant.numeric", "//x:comment"],
    ],
    ["use ./a//c", ["use:keyword", "./a:string", "//c:comment"]],
    ["godebug x=", ["godebug:keyword", "x:variable", "=:keyword.operator"]],
    ["godebug x=// c", ["godebug:keyword", "x:variable", "=:keyword.operator", "// c:comment"]],
    ["replace . => ./x", ["replace:keyword", ".:string", "=>:keyword.operator", "./x:string"]],
    [
      'require "a\\"b c" v1.0.0',
      ["require:keyword", '"a\\"b c":string', "v1.0.0:constant.numeric"],
    ],
    ["toolchain go1.21.0-a+b", ["toolchain:keyword", "go1.21.0-a+b:constant.numeric"]],
  ])("%s", (line, tokens) => {
    expect(tokenize(line, language)).toEqual([tokens]);
  });

  test("blocks hold paths, not directives, and the state ends at the closing paren", () => {
    expect(tokenize("require (\n\trequire v1.0.0\n)\ngo 1.26", language)).toEqual([
      ["require:keyword", "(:punctuation.section"],
      ["require:entity.name.type", "v1.0.0:constant.numeric"],
      ["):punctuation.section"],
      ["go:keyword", "1.26:constant.numeric"],
    ]);
  });

  test("a closing paren after a godebug value still ends the block", () => {
    expect(tokenize("godebug (panicnil=1)\ngo 1.26", language)).toEqual([
      [
        "godebug:keyword",
        "(:punctuation.section",
        "panicnil:variable",
        "=:keyword.operator",
        "1:string",
        "):punctuation.section",
      ],
      ["go:keyword", "1.26:constant.numeric"],
    ]);
  });

  test.each(["v2ray.com/core", "1password.com/sdk", "go1.example.com/x"])(
    "keeps the version-like module path %s a path",
    (path) => {
      expect(tokenize(`require ${path} v1.0.0`, language)).toEqual([
        ["require:keyword", `${path}:entity.name.type`, "v1.0.0:constant.numeric"],
      ]);
    },
  );
});

describe("go.sum tokenizer", () => {
  test.each([
    [
      "a.b/c v1.2.3 h1:abc+/=",
      ["a.b/c:entity.name.type", "v1.2.3:constant.numeric", "h1:abc+/=:string"],
    ],
    [
      "a.b/c v1.2.3/go.mod h1:abc=",
      ["a.b/c:entity.name.type", "v1.2.3/go.mod:constant.numeric", "h1:abc=:string"],
    ],
    [
      "v2ray.com/core v4.0.0+incompatible h1:abc=",
      ["v2ray.com/core:entity.name.type", "v4.0.0+incompatible:constant.numeric", "h1:abc=:string"],
    ],
  ])("%s", (line, tokens) => {
    expect(tokenize(line, "go.sum")).toEqual([tokens]);
  });
});
