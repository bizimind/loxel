import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEditorConfig, resolveEditorConfig } from "./editorconfig";
import { compileSectionGlob, globMatches } from "./editorconfig-glob";

describe("parseEditorConfig", () => {
  test("reads root from the preamble only, and skips comments and malformed sections", () => {
    const config = parseEditorConfig(
      [
        "# top comment",
        "ROOT = True",
        "",
        "[*]",
        "; comment",
        "Indent_Style = Space",
        "root = false",
        "[unclosed",
        "indent_size = 8",
        "[*.py]",
        "indent_size = 4",
      ].join("\r\n"),
    );
    expect(config.root).toBe(true);
    expect(config.sections.map((section) => section.properties)).toEqual([
      [
        ["indent_style", "Space"],
        ["root", "false"],
      ],
      [["indent_size", "4"]],
    ]);
  });
});

describe("section globs", () => {
  test.each([
    ["*", "a.py", true],
    ["*", "src/deep/a.py", true],
    ["*.py", "src/a.py", true],
    ["*.py", "src/a.pyi", false],
    ["*.{js,ts}", "x/y.ts", true],
    ["*.{js,ts}", "x/y.tsx", false],
    ["{package.json,.travis.yml}", "package.json", true],
    ["{package.json,.travis.yml}", "sub/.travis.yml", true],
    ["Makefile", "build/Makefile", true],
    ["lib/**.js", "lib/a/b.js", true],
    ["lib/**.js", "src/lib/a.js", false],
    ["/lib/*.js", "lib/a.js", true],
    ["/lib/*.js", "lib/a/b.js", false],
    ["src/**/*.go", "src/main.go", true],
    ["src/**/*.go", "src/a/b/main.go", true],
    ["a?c.txt", "abc.txt", true],
    ["a?c.txt", "a/c.txt", false],
    ["[abc].md", "b.md", true],
    ["[!abc].md", "b.md", false],
    ["[!abc].md", "d.md", true],
    ["file{1..3}.txt", "file2.txt", true],
    ["file{1..3}.txt", "file4.txt", false],
    ["{single}.txt", "{single}.txt", true],
    ["{single}.txt", "single.txt", false],
    ["\\*.txt", "*.txt", true],
    ["\\*.txt", "a.txt", false],
    ["*.min.js", "a.minxjs", false],
    ["{foo,bar{1..3}}", "foo", true],
    ["{foo,bar{1..3}}", "bar3", true],
    ["{a{1..3},b}.txt", "b.txt", true],
    ["file{-2..2}.txt", "file-1.txt", true],
    ["[\\]]x", "]x", true],
    ["[\\]]x", "\\x", false],
    ["[a-c]x", "bx", true],
    ["[a\\-c]x", "bx", false],
    ["[a\\-c]x", "-x", true],
  ])("%p matches %p: %p", (glob, path, expected) => {
    expect(globMatches(compileSectionGlob(glob), path)).toBe(expected);
  });
});

test("a pathological glob matches in linear time", () => {
  const glob = compileSectionGlob("*a*a*a*a*a*a*a*a*a*a*b");
  const start = performance.now();
  expect(globMatches(glob, "a".repeat(250))).toBe(false);
  expect(performance.now() - start).toBeLessThan(50);
});

test("an oversized section name or expansion is ignored", () => {
  const config = parseEditorConfig(
    `[${"*".repeat(2000)}]\nindent_size = 4\n[*]\nindent_size = 2\n`,
  );
  expect(config.sections.map((section) => section.properties)).toEqual([[["indent_size", "2"]]]);
  const start = performance.now();
  const glob = compileSectionGlob(`{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}${"*".repeat(1000)}`);
  expect(globMatches(glob, "a".repeat(200))).toBe(false);
  expect(performance.now() - start).toBeLessThan(50);
});

test("a glob expanding to too many alternatives matches nothing", () => {
  expect(
    globMatches(compileSectionGlob("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}"), "aaaaaaaaa"),
  ).toBe(false);
  expect(
    globMatches(compileSectionGlob("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}"), "abababab"),
  ).toBe(true);
});

describe("resolveEditorConfig", () => {
  let base: string;
  let repo: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "loxel-editorconfig-")));
    repo = join(base, "repo");
    await mkdir(join(repo, "pkg", "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function write(path: string, lines: string[]): Promise<void> {
    await writeFile(join(base, path), lines.join("\n"));
  }

  test("the nearest file's last matching section wins, per property", async () => {
    await write("repo/.editorconfig", [
      "[*]",
      "indent_style = space",
      "indent_size = 2",
      "insert_final_newline = true",
      "[*.py]",
      "indent_size = 4",
    ]);
    await write("repo/pkg/.editorconfig", [
      "[*.py]",
      "indent_style = tab",
      "[src/*.py]",
      "trim_trailing_whitespace = true",
    ]);
    expect(await resolveEditorConfig(join(repo, "pkg/src/a.py"), repo)).toEqual({
      indentStyle: "tab",
      indentSize: 4,
      tabWidth: 4,
      insertFinalNewline: true,
      trimTrailingWhitespace: true,
    });
    // `src/*.py` is anchored at pkg/, so it does not match pkg/a.py's sibling directories.
    expect(await resolveEditorConfig(join(repo, "pkg/a.py"), repo)).toEqual({
      indentStyle: "tab",
      indentSize: 4,
      tabWidth: 4,
      insertFinalNewline: true,
    });
  });

  test("stops at root = true and at the tree root", async () => {
    await write(".editorconfig", ["[*]", "end_of_line = crlf"]);
    await write("repo/.editorconfig", ["[*]", "indent_size = 3"]);
    await write("repo/pkg/.editorconfig", ["root = true", "[*]", "indent_style = tab"]);
    expect(await resolveEditorConfig(join(repo, "pkg/a.go"), repo)).toEqual({ indentStyle: "tab" });
    // Without root = true below it, the lookup still ends at the tree root.
    expect(await resolveEditorConfig(join(repo, "b.go"), repo)).toEqual({
      indentSize: 3,
      tabWidth: 3,
    });
    expect(await resolveEditorConfig(join(base, "elsewhere/c.go"), repo)).toEqual({});
  });

  test("applies unset, indent_size = tab and value normalization", async () => {
    await write("repo/.editorconfig", [
      "[*]",
      "indent_style = TAB",
      "tab_width = 8",
      "end_of_line = CRLF",
      "trim_trailing_whitespace = true",
      "[*.md]",
      "trim_trailing_whitespace = unset",
      "end_of_line = cr",
      "[*.txt]",
      "indent_style = space",
      "indent_size = tab",
      "insert_final_newline = true # with a comment",
    ]);
    expect(await resolveEditorConfig(join(repo, "a.md"), repo)).toEqual({
      indentStyle: "tab",
      indentSize: 8,
      tabWidth: 8,
    });
    expect(await resolveEditorConfig(join(repo, "a.txt"), repo)).toEqual({
      indentStyle: "space",
      indentSize: 8,
      tabWidth: 8,
      endOfLine: "crlf",
      insertFinalNewline: true,
      trimTrailingWhitespace: true,
    });
  });

  test("re-reads a file that changed, appeared or was removed", async () => {
    const file = join(repo, "pkg/a.ts");
    expect(await resolveEditorConfig(file, repo)).toEqual({});
    await write("repo/.editorconfig", ["[*]", "indent_size = 2"]);
    expect(await resolveEditorConfig(file, repo)).toEqual({ indentSize: 2, tabWidth: 2 });
    await write("repo/.editorconfig", ["[*]", "indent_size = 16"]);
    expect(await resolveEditorConfig(file, repo)).toEqual({ indentSize: 16, tabWidth: 16 });
    await rm(join(repo, ".editorconfig"));
    expect(await resolveEditorConfig(file, repo)).toEqual({});
  });
});
