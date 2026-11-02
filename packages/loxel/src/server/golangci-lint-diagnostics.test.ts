import { describe, expect, test } from "bun:test";

import {
  type GolangciLintIssue,
  goplsReportsToo,
  parseGolangciLintReport,
  toGolangciLintDiagnostic,
} from "./golangci-lint-diagnostics";

function issue(overrides: Partial<GolangciLintIssue> & { line?: number; column?: number }) {
  const { line = 1, column = 1, ...rest } = overrides;
  return {
    FromLinter: "errcheck",
    Text: "said",
    Severity: "",
    Pos: { Filename: "/w/a.go", Line: line, Column: column },
    ...rest,
  };
}

describe("parseGolangciLintReport", () => {
  test("reads issues and the report's error", () => {
    const report = parseGolangciLintReport(
      JSON.stringify({
        Issues: [issue({})],
        Report: { Error: "typechecking error: x", Linters: [] },
      }),
    );
    expect(report?.issues).toHaveLength(1);
    expect(report?.error).toBe("typechecking error: x");
  });

  test("anything else is no report, so never a clean run", () => {
    expect(parseGolangciLintReport("")).toBeNull();
    expect(parseGolangciLintReport("level=info\n{}")).toBeNull();
    expect(parseGolangciLintReport('{"Report":{}}')).toBeNull();
    expect(parseGolangciLintReport('{"Issues":null}')).toBeNull();
  });
});

describe("toGolangciLintDiagnostic", () => {
  test("converts a byte column to UTF-16 and ranges over the identifier", () => {
    const line = 'x := "é😀" + name';
    const byteColumn = Buffer.byteLength(line.slice(0, line.indexOf("name")));
    const { range } = toGolangciLintDiagnostic(issue({ column: byteColumn + 1 }), [line]);
    expect(range.start).toEqual({ line: 0, character: line.indexOf("name") });
    expect(range.end).toEqual({ line: 0, character: line.length });
  });

  test("a column on punctuation covers that character, a surrogate pair whole", () => {
    expect(toGolangciLintDiagnostic(issue({ column: 2 }), ["a := 1"]).range.end.character).toBe(2);
    expect(toGolangciLintDiagnostic(issue({ column: 1 }), ["😀"]).range.end.character).toBe(2);
  });

  test("column 0 means the whole line", () => {
    const { range } = toGolangciLintDiagnostic(issue({ line: 2, column: 0 }), ["a", "\tfunc f()"]);
    expect(range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: "\tfunc f()".length },
    });
  });

  test("a position past the file stays in range", () => {
    const { range } = toGolangciLintDiagnostic(issue({ line: 9, column: 40 }), ["a"]);
    expect(range.start).toEqual({ line: 8, character: 0 });
    expect(range.end).toEqual({ line: 8, character: 0 });
    const inLine = toGolangciLintDiagnostic(issue({ column: 40 }), ["abc"]).range;
    expect(inLine.start.character).toBe(3);
    expect(inLine.end.character).toBe(3);
  });

  test("defaults to a warning and reads a config's severities", () => {
    const severity = (Severity: string) =>
      toGolangciLintDiagnostic(issue({ Severity }), ["a"]).severity;
    expect(severity("")).toBe(2);
    expect(severity("blocker")).toBe(2);
    expect(severity("error")).toBe(1);
    expect(severity("ERROR")).toBe(1);
    expect(severity("info")).toBe(3);
    expect(severity("hint")).toBe(4);
  });

  test("links the linter's docs, or staticcheck's check", () => {
    const plain = toGolangciLintDiagnostic(issue({}), ["a"]);
    expect(plain.source).toBe("golangci-lint");
    expect(plain.code).toBe("errcheck");
    expect(plain.codeDescription.href).toBe(
      "https://golangci-lint.run/docs/linters/configuration/#errcheck",
    );
    const check = toGolangciLintDiagnostic(
      issue({ FromLinter: "staticcheck", Text: "SA4006: this value is unused" }),
      ["a"],
    );
    expect(check.code).toBe("staticcheck");
    expect(check.codeDescription.href).toBe("https://staticcheck.dev/docs/checks/#SA4006");
    const noCheck = toGolangciLintDiagnostic(
      issue({ FromLinter: "staticcheck", Text: "S1021: should merge" }),
      ["a"],
    );
    expect(noCheck.codeDescription.href).toContain("#staticcheck");
  });

  test("keeps suggested fixes on the diagnostic", () => {
    const fixes = [{ Message: "fix", TextEdits: [{ Pos: 1, End: 2, NewText: "x" }] }];
    expect(toGolangciLintDiagnostic(issue({ SuggestedFixes: fixes }), ["a"]).data).toEqual({
      suggestedFixes: fixes,
    });
    expect(toGolangciLintDiagnostic(issue({ SuggestedFixes: [] }), ["a"]).data).toBeUndefined();
    expect(toGolangciLintDiagnostic(issue({}), ["a"]).data).toBeUndefined();
  });
});

describe("goplsReportsToo", () => {
  test("covers what gopls runs by default, and nothing else", () => {
    const of = (FromLinter: string, Text: string) => goplsReportsToo(issue({ FromLinter, Text }));
    expect(of("govet", "printf: fmt.Printf format %s has arg x of wrong type int")).toBe(true);
    expect(of("govet", "shadow: declaration of err shadows")).toBe(false);
    expect(of("govet", "fieldalignment: struct could be smaller")).toBe(false);
    expect(of("staticcheck", "SA4000: identical expressions")).toBe(true);
    expect(of("staticcheck", "SA4006: this value is unused")).toBe(false);
    expect(of("errcheck", "printf: not vet")).toBe(false);
  });
});
