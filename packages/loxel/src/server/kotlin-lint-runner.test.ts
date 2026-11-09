import { describe, expect, test } from "bun:test";

import { parseKtlintJson, parseSarif } from "./kotlin-lint-runner";

// Both samples have the shapes measured from detekt 1.23.8, detekt 2.0.0-alpha.6 and ktlint 1.8.0.

function sarifResult(uri: Record<string, string>, extra: Record<string, unknown> = {}): unknown {
  return {
    locations: [
      {
        physicalLocation: {
          artifactLocation: uri,
          region: { startLine: 8, startColumn: 44, endLine: 8, endColumn: 47 },
        },
      },
    ],
    message: { text: "Empty catch block detected." },
    ruleId: "detekt.empty-blocks.EmptyCatchBlock",
    ...extra,
  };
}

describe("parseSarif", () => {
  test("1.x: a level on the result and an absolute URI", () => {
    const report = {
      runs: [{ results: [sarifResult({ uri: "file:///w/a%20b/A.kt" }, { level: "warning" })] }],
    };
    expect(parseSarif(report, "/w")?.get("/w/a b/A.kt")).toEqual([
      {
        range: { start: { line: 7, character: 43 }, end: { line: 7, character: 46 } },
        severity: 2,
        source: "detekt",
        message: "Empty catch block detected.",
        code: "EmptyCatchBlock",
        codeDescription: { href: "https://detekt.dev/docs/rules/empty-blocks#emptycatchblock" },
      },
    ]);
  });

  test("2.x: the rule's default level and a path relative to the base path, not encoded", () => {
    const report = {
      runs: [
        {
          tool: {
            driver: {
              rules: [
                {
                  id: "detekt.empty-blocks.EmptyCatchBlock",
                  defaultConfiguration: { level: "error" },
                },
              ],
            },
          },
          results: [sarifResult({ uri: "src/B,c d.kt", uriBaseId: "%SRCROOT%" })],
        },
      ],
    };
    const [diagnostic] = parseSarif(report, "/w/mod")?.get("/w/mod/src/B,c d.kt") ?? [];
    expect(diagnostic?.severity).toBe(1);
  });

  test("a result's own level beats its rule's default; no level at all is a warning", () => {
    const rules = [{ id: "detekt.a.B", defaultConfiguration: { level: "error" } }];
    const report = {
      runs: [
        {
          tool: { driver: { rules } },
          results: [
            sarifResult({ uri: "A.kt" }, { ruleId: "detekt.a.B", level: "note" }),
            sarifResult({ uri: "B.kt" }, { ruleId: "detekt.c.D" }),
          ],
        },
      ],
    };
    const diagnostics = parseSarif(report, "/w");
    expect(diagnostics?.get("/w/A.kt")?.[0]?.severity).toBe(3);
    expect(diagnostics?.get("/w/B.kt")?.[0]?.severity).toBe(2);
  });

  test("anything else is no report", () => {
    expect(parseSarif(null, "/w")).toBeNull();
    expect(parseSarif([], "/w")).toBeNull();
    expect(parseSarif({ runs: [{ results: [{ ruleId: "x" }, "y"] }] }, "/w")?.size).toBe(0);
  });
});

describe("parseKtlintJson", () => {
  test("a violation links the standard rules page", () => {
    const report = [
      {
        file: "/w/A.kt",
        errors: [{ line: 3, column: 2, message: "Wildcard", rule: "standard:no-wildcard-imports" }],
      },
    ];
    expect(parseKtlintJson(report)?.get("/w/A.kt")).toEqual([
      {
        range: { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } },
        severity: 1,
        source: "ktlint",
        message: "Wildcard",
        code: "standard:no-wildcard-imports",
        codeDescription: { href: "https://ktlint.github.io/ktlint/latest/rules/standard/" },
      },
    ]);
  });

  test("a syntax error, with its empty rule, has no code", () => {
    const report = [
      { file: "/w/A.kt", errors: [{ line: 1, column: 6, message: "Not valid", rule: "" }] },
    ];
    const [diagnostic] = parseKtlintJson(report)?.get("/w/A.kt") ?? [];
    expect(diagnostic?.message).toBe("Not valid");
    expect(diagnostic).not.toHaveProperty("code");
  });

  test("a clean run is empty; a crash, with no report, is not a report", () => {
    expect(parseKtlintJson([])?.size).toBe(0);
    expect(parseKtlintJson(null)).toBeNull();
  });
});
