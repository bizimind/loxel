import { describe, expect, test } from "bun:test";

import { detectIndentation } from "./detect-indentation";

const lines = (...l: string[]) => l.join("\n");

describe("detectIndentation", () => {
  test("detects the space indent size from the indent steps", () => {
    const fourSpaces = lines("function f() {", "    if (x) {", "        y();", "    }", "}");
    expect(detectIndentation(fourSpaces)).toEqual({
      insertSpaces: true,
      tabSize: 4,
      indentSize: 4,
    });
    const twoSpaces = lines("a:", "  b:", "    c: 1", "  d: 2");
    expect(detectIndentation(twoSpaces)).toEqual({ insertSpaces: true, tabSize: 2, indentSize: 2 });
  });

  test("detects tabs without a size", () => {
    expect(detectIndentation(lines("func f() {", "\tif x {", "\t\ty()", "\t}", "}"))).toEqual({
      insertSpaces: false,
    });
  });

  test("goes with the majority of indented lines", () => {
    const mostlyTabs = lines("a {", "\tb", "\tc", "    d", "}");
    expect(detectIndentation(mostlyTabs)).toEqual({ insertSpaces: false });
  });

  test("sets nothing when the content does not tell", () => {
    expect(detectIndentation("")).toEqual({});
    expect(detectIndentation(lines("a", "b", "", "c"))).toEqual({});
    // As many tab-indented lines as space-indented ones.
    expect(detectIndentation(lines("a", "\tb", "c", "  d"))).toEqual({});
  });

  test("prefers 2 over 4 when deeper nesting makes 4-column steps", () => {
    const yaml = lines("a:", "  b:", "    c:", "      d: 1", "  e: 2", "f:", "  g: 1");
    expect(detectIndentation(yaml).indentSize).toBe(2);
  });

  test("ignores blank and whitespace-only lines, and CRLF line endings", () => {
    const content = "def f():\r\n\r\n    x = 1\r\n        \r\n    if x:\r\n        y()\r\n";
    expect(detectIndentation(content)).toEqual({ insertSpaces: true, tabSize: 4, indentSize: 4 });
  });

  test("does not count alignment after a comma-ended line as an indent step", () => {
    const content = lines(
      "function f() {",
      "  const a = 1,",
      "        b = 2;",
      "  const c = 1,",
      "        d = 2;",
      "  const e = 1,",
      "        g = 2;",
      "}",
    );
    expect(detectIndentation(content).indentSize).toBe(2);
  });

  test("ignores the one-space continuation of block comments", () => {
    const content = lines("/**", " * Doc.", " */", "function f() {", "    return 1;", "}");
    expect(detectIndentation(content).indentSize).toBe(4);
  });
});
