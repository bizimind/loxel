import { describe, expect, test } from "bun:test";

import { golangciLintCodeActions, nolintEdit, rangesTouch } from "./golangci-lint-code-actions";
import type { GolangciLintDiagnostic } from "./golangci-lint-diagnostics";

const URI = "file:///a.go";

const base64 = (text: string): string => Buffer.from(text).toString("base64");

function diagnostic(suggestedFixes?: unknown[], line = 0, code = "lint"): GolangciLintDiagnostic {
  const position = { line, character: 0 };
  return {
    range: { start: position, end: position },
    severity: 2,
    source: "golangci-lint",
    code,
    codeDescription: { href: "https://example.invalid" },
    message: "m",
    ...(suggestedFixes ? { data: { suggestedFixes } } : {}),
  };
}

function actions(text: string, ...diagnostics: GolangciLintDiagnostic[]) {
  return golangciLintCodeActions({ uri: URI, version: 7 }, Buffer.from(text), diagnostics);
}

function editsOf(action: ReturnType<typeof actions>[number] | undefined) {
  return action?.edit.documentChanges[0]?.edits;
}

/** What `text` becomes with `edit` on its one line. */
function applied(text: string, line: number, linter: string): string | null {
  const edit = nolintEdit(text, line, linter);
  if (!edit) return null;
  const lines = text.split("\n");
  const target = lines[line] ?? "";
  const { character } = edit.range.start;
  lines[line] = target.slice(0, character) + edit.newText + target.slice(character);
  return lines.join("\n");
}

describe("suggested fixes", () => {
  test("converts byte offsets and base64, naming the linter", () => {
    const text = 'package a\n\nvar s = "é" + "Etag"\n';
    const offset = Buffer.from(text).indexOf('"Etag"');
    const [fix] = actions(
      text,
      diagnostic([
        {
          Message: "use  ETag\n instead",
          TextEdits: [{ Pos: offset, End: offset + 6, NewText: base64('"ETag"') }],
        },
      ]),
    );
    expect(fix?.title).toBe("lint: use ETag instead");
    expect(fix?.kind).toBe("quickfix");
    expect(fix).not.toHaveProperty("isPreferred");
    // `é` takes two bytes before the column and one UTF-16 unit.
    expect(fix?.edit.documentChanges[0]?.textDocument).toEqual({ uri: URI, version: 7 });
    expect(editsOf(fix)).toEqual([
      {
        range: { start: { line: 2, character: 14 }, end: { line: 2, character: 20 } },
        newText: '"ETag"',
      },
    ]);
  });

  test("counts astral characters as two UTF-16 units", () => {
    const text = "// 😀x\n";
    const offset = Buffer.from(text).indexOf("x");
    const [fix] = actions(
      text,
      diagnostic([{ TextEdits: [{ Pos: offset, End: offset + 1, NewText: base64("y") }] }]),
    );
    expect(editsOf(fix)?.[0]?.range.start).toEqual({ line: 0, character: 5 });
  });

  test("keeps every edit of a fix, in order, with null text as a deletion", () => {
    const [fix] = actions(
      "abcdef\nghi\n",
      diagnostic([
        {
          Message: "several",
          TextEdits: [
            { Pos: 8, End: 9, NewText: null },
            { Pos: 0, End: 1, NewText: base64("A") },
            { Pos: 3, End: 3, NewText: base64("-") },
          ],
        },
      ]),
    );
    expect(editsOf(fix)).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" },
      { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: "-" },
      { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, newText: "" },
    ]);
  });

  test("one action per alternative, with a generic title when there is no message", () => {
    const edit = (Pos: number) => ({ TextEdits: [{ Pos, End: Pos + 1, NewText: base64("x") }] });
    const titled = actions("abc\n", diagnostic([{ Message: "", ...edit(0) }, edit(1)]));
    expect(titled.map((action) => action.title)).toEqual([
      "Apply lint fix",
      "Apply lint fix",
      "lint: Disable for this line",
    ]);
  });

  test("leaves out a fix that doesn't fit the file", () => {
    const text = "é = 1\n";
    const bad = [
      { Message: "past the end", TextEdits: [{ Pos: 0, End: 100, NewText: null }] },
      { Message: "reversed", TextEdits: [{ Pos: 2, End: 1, NewText: null }] },
      { Message: "inside a character", TextEdits: [{ Pos: 1, End: 2, NewText: null }] },
      {
        Message: "overlapping",
        TextEdits: [
          { Pos: 0, End: 3, NewText: null },
          { Pos: 2, End: 4, NewText: null },
        ],
      },
      { Message: "not text", TextEdits: [{ Pos: 0, End: 0, NewText: "/w==" }] },
      { Message: "no edits", TextEdits: [] },
      { Message: "not a fix" },
    ];
    expect(actions(text, diagnostic(bad)).map((action) => action.title)).toEqual([
      "lint: Disable for this line",
    ]);
  });

  test("offers what several diagnostics share once", () => {
    const fix = { Message: "same", TextEdits: [{ Pos: 0, End: 1, NewText: base64("x") }] };
    expect(
      actions("a := 1\n", diagnostic([fix]), diagnostic([fix])).map((action) => action.title),
    ).toEqual(["lint: same", "lint: Disable for this line"]);
  });
});

describe("nolint", () => {
  test.each([
    ["appends to a line with no comment", "x := 1", "x := 1 //nolint:b"],
    ["goes before an ordinary comment", "x := 1 // why", "x := 1 //nolint:b // why"],
    ["merges into a list", "x := 1 //nolint:a", "x := 1 //nolint:a,b"],
    ["merges into a longer list", "x //nolint:a,c", "x //nolint:a,c,b"],
    ["keeps an explanation after the list", "x //nolint:a // why", "x //nolint:a,b // why"],
    ["merges with a space before it", "x // nolint:a", "x // nolint:a,b"],
    ["keeps CRLF", "x := 1\r", "x := 1 //nolint:b\r"],
    ["ignores // in a string", 'x := "a//b"', 'x := "a//b" //nolint:b'],
    [
      "ignores // in a rune-quoted string",
      String.raw`x := '"' // c`,
      String.raw`x := '"' //nolint:b // c`,
    ],
    ["handles an escaped quote", String.raw`x := "a\"//b"`, String.raw`x := "a\"//b" //nolint:b`],
    ["appends after a block comment", "x := 1 /* c */", "x := 1 /* c */ //nolint:b"],
    ["appends after a raw string closes", "x := `//` + y", "x := `//` + y //nolint:b"],
  ])("%s", (_name, line, expected) => {
    expect(applied(line, 0, "b")).toBe(expected);
  });

  test.each([
    ["a bare directive covers everything", "x //nolint"],
    ["a bare directive with an explanation", "x //nolint // why"],
    ["nolint:all covers everything", "x //nolint:all"],
    ["all later in the list", "x //nolint:a,all"],
    ["the linter is already named", "x //nolint:a,B"],
    ["a comment on a line of its own", "\t// comment"],
    ["a blank line", "   "],
    ["a line opening a raw string", "x := `text"],
    ["a line opening a block comment", "x := 1 /* text"],
    ["past the end of the file", ""],
  ])("not offered: %s", (_name, line) => {
    expect(nolintEdit(line, 0, "b")).toBeNull();
  });

  test("lines inside and after a raw string or block comment", () => {
    const raw = "x := `one\ntwo\nthree` + y\n";
    expect(nolintEdit(raw, 0, "b")).toBeNull();
    expect(nolintEdit(raw, 1, "b")).toBeNull();
    expect(applied(raw, 2, "b")).toBe("x := `one\ntwo\nthree` + y //nolint:b\n");
    const block = "/* one\ntwo */ x\n/* three\nfour */\n";
    expect(nolintEdit(block, 0, "b")).toBeNull();
    expect(applied(block, 1, "b")).toBe("/* one\ntwo */ x //nolint:b\n/* three\nfour */\n");
    expect(nolintEdit(block, 3, "b")).toBeNull();
  });

  test("offered with the diagnostic's linter on its line", () => {
    const [action] = actions(
      "package a\n\nvar x = 1\n",
      diagnostic(undefined, 2, "gochecknoglobals"),
    );
    expect(action?.title).toBe("gochecknoglobals: Disable for this line");
    expect(editsOf(action)?.[0]?.newText).toBe(" //nolint:gochecknoglobals");
  });
});

test("rangesTouch", () => {
  const range = (a: number, b: number, c: number, d: number) => ({
    start: { line: a, character: b },
    end: { line: c, character: d },
  });
  expect(rangesTouch(range(1, 2, 1, 5), range(1, 5, 1, 5))).toBe(true);
  expect(rangesTouch(range(1, 2, 1, 5), range(1, 6, 1, 6))).toBe(false);
  expect(rangesTouch(range(1, 2, 1, 5), range(0, 0, 3, 0))).toBe(true);
  expect(rangesTouch(range(1, 2, 1, 5), range(2, 0, 2, 1))).toBe(false);
});
