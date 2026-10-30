import { describe, expect, test } from "bun:test";

import { parseMypyOutput } from "./mypy-daemon";

const ROOT = "/wt/app";

describe("parseMypyOutput", () => {
  test("reads JSON reports, with ends, code links and hints, skipping daemon chatter", () => {
    const stdout = [
      "Daemon started",
      JSON.stringify({
        file: "src/app.py",
        line: 10,
        column: 19,
        end_line: 10,
        end_column: 24,
        message: 'Unsupported operand types for + ("str" and "int")',
        hint: null,
        code: "operator",
        severity: "error",
      }),
      JSON.stringify({
        file: "src/app.py",
        line: 16,
        column: 0,
        end_line: 16,
        end_column: 1,
        message: 'Cannot find implementation or library stub for module named "missing"',
        hint: "See https://mypy.readthedocs.io/en/stable/running_mypy.html#missing-imports",
        code: "import-not-found",
        severity: "error",
      }),
      JSON.stringify({
        file: "/elsewhere/lib.py",
        line: 2,
        column: 4,
        message: 'Revealed type is "int"',
        hint: null,
        code: "misc",
        severity: "note",
      }),
    ].join("\n");
    const { diagnostics, otherLines } = parseMypyOutput(stdout, ROOT, true);
    expect(otherLines).toEqual(["Daemon started"]);
    expect(diagnostics.get("/wt/app/src/app.py")).toEqual([
      {
        range: { start: { line: 9, character: 19 }, end: { line: 9, character: 24 } },
        severity: 1,
        source: "mypy",
        message: 'Unsupported operand types for + ("str" and "int")',
        code: "operator",
        codeDescription: { href: "https://mypy.readthedocs.io/en/stable/_refs.html#code-operator" },
      },
      {
        range: { start: { line: 15, character: 0 }, end: { line: 15, character: 1 } },
        severity: 1,
        source: "mypy",
        message:
          'Cannot find implementation or library stub for module named "missing"\n' +
          "See https://mypy.readthedocs.io/en/stable/running_mypy.html#missing-imports",
        code: "import-not-found",
        codeDescription: {
          href: "https://mypy.readthedocs.io/en/stable/_refs.html#code-import-not-found",
        },
      },
    ]);
    // Without an end, the report covers its start; notes are informational.
    expect(diagnostics.get("/elsewhere/lib.py")?.[0]).toMatchObject({
      range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } },
      severity: 3,
    });
  });

  test("reads the text format of mypy releases without JSON output", () => {
    const stdout = [
      'src/app.py:10:20:10:24: error: Unsupported operand types for + ("str" and "int")  [operator]',
      'src/app.py: note: In function "f":',
      "src/app.py:3:1:3:1: note: Some note",
      "mypy.ini: [mypy]: Unrecognized option: bogus = 1",
    ].join("\n");
    const { diagnostics, otherLines } = parseMypyOutput(stdout, ROOT, false);
    expect(diagnostics.get("/wt/app/src/app.py")).toEqual([
      {
        range: { start: { line: 9, character: 19 }, end: { line: 9, character: 24 } },
        severity: 1,
        source: "mypy",
        message: 'Unsupported operand types for + ("str" and "int")',
        code: "operator",
        codeDescription: { href: "https://mypy.readthedocs.io/en/stable/_refs.html#code-operator" },
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
        severity: 3,
        source: "mypy",
        message: "Some note",
      },
    ]);
    expect(otherLines).toEqual([
      'src/app.py: note: In function "f":',
      "mypy.ini: [mypy]: Unrecognized option: bogus = 1",
    ]);
  });
});
