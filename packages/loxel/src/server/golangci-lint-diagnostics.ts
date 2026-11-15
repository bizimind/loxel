/** golangci-lint's JSON report, and its issues as language-server diagnostics. */
import { z } from "zod";

const SEVERITY = { error: 1, warning: 2, info: 3, hint: 4 } as const;

const LINTER_DOCS = "https://golangci-lint.run/docs/linters/configuration/#";
const STATICCHECK_DOCS = "https://staticcheck.dev/docs/checks/#";
const STATICCHECK_CODE = /^(?:SA|ST)\d+\b/;
const IDENTIFIER_AT_START = /^[\p{L}\p{N}_]+/u;

/**
 * What gopls itself reports, with the same position and words, so golangci-lint's copy would be a
 * second marker: the `go vet` analyzers it runs by default and its default staticcheck checks.
 * Reported at that severity whatever the project's config, and what is not listed here stays.
 */
const GOPLS_VET_ANALYZERS: ReadonlySet<string> = new Set(
  `appends asmdecl assign atomic atomicalign bools buildtag cgocall composites copylocks
  deepequalerrors defers directive errorsas framepointer hostport httpresponse ifaceassert
  loopclosure lostcancel nilfunc nilness printf shift sigchanyzer slog sortslice stdmethods
  stdversion stringintconv structtag testinggoroutine tests timeformat unmarshal unreachable
  unsafeptr unusedresult unusedwrite waitgroup`.split(/\s+/),
);
const GOPLS_STATICCHECK_CHECKS: ReadonlySet<string> = new Set(
  `SA1001 SA1004 SA1005 SA1008 SA1012 SA1013 SA1016 SA2001 SA3000 SA3001 SA4000 SA4001 SA4003
  SA4004 SA4011 SA4013 SA4014 SA4016 SA4019 SA4020 SA4022 SA4024 SA4025 SA4026 SA4027 SA4028
  SA4029 SA4030 SA4032 SA5001 SA5003 SA5004 SA5008 SA6005 SA6006 SA9002 SA9004 SA9006 SA9009
  SA9010`.split(/\s+/),
);

const IssueSchema = z.object({
  FromLinter: z.string(),
  Text: z.string(),
  Severity: z.string().optional(),
  Pos: z.object({ Filename: z.string(), Line: z.number(), Column: z.number() }),
  SuggestedFixes: z.array(z.unknown()).nullish(),
});

const ReportSchema = z.object({
  Issues: z.array(IssueSchema),
  Report: z.object({ Error: z.string().optional() }).optional(),
});

export type GolangciLintIssue = z.infer<typeof IssueSchema>;

export interface GolangciLintReport {
  issues: GolangciLintIssue[];
  /** What stopped part of the run, when something did. */
  error: string | null;
}

/** A language-server diagnostic, as `textDocument/publishDiagnostics` carries it. */
export interface GolangciLintDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: (typeof SEVERITY)[keyof typeof SEVERITY];
  source: "golangci-lint";
  code: string;
  codeDescription: { href: string };
  message: string;
  /** The linter's own fixes, as golangci-lint reports them. */
  data?: { suggestedFixes: unknown[] };
}

/** The report in `text`, or null when it is not one. */
export function parseGolangciLintReport(text: string): GolangciLintReport | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ReportSchema.safeParse(value);
  if (!parsed.success) return null;
  return { issues: parsed.data.Issues, error: parsed.data.Report?.Error ?? null };
}

/** Whether gopls already shows `issue` in the same file. */
export function goplsReportsToo({ FromLinter, Text }: GolangciLintIssue): boolean {
  if (FromLinter === "govet") return GOPLS_VET_ANALYZERS.has(Text.split(":", 1)[0] ?? "");
  if (FromLinter === "staticcheck")
    return GOPLS_STATICCHECK_CHECKS.has(Text.split(":", 1)[0] ?? "");
  return false;
}

/**
 * `issue` as a diagnostic in a file with these `lines`. golangci-lint gives a 1-based byte column
 * and no end: the range is the identifier at that column, or that one character, and column 0 means
 * the whole line.
 */
export function toGolangciLintDiagnostic(
  issue: GolangciLintIssue,
  lines: readonly string[],
): GolangciLintDiagnostic {
  const { FromLinter: linter, Text: message, Pos: pos } = issue;
  const line = Math.max(pos.Line - 1, 0);
  const text = lines[line] ?? "";
  const start = pos.Column > 0 ? utf16Column(text, pos.Column - 1) : 0;
  const end = pos.Column > 0 ? tokenEnd(text, start) : text.length;
  const check = linter === "staticcheck" ? STATICCHECK_CODE.exec(message)?.[0] : undefined;
  const fixes = issue.SuggestedFixes;
  return {
    range: { start: { line, character: start }, end: { line, character: end } },
    severity: severityOf(issue.Severity),
    source: "golangci-lint",
    code: linter,
    codeDescription: { href: check ? `${STATICCHECK_DOCS}${check}` : `${LINTER_DOCS}${linter}` },
    message,
    ...(fixes && fixes.length > 0 ? { data: { suggestedFixes: fixes } } : {}),
  };
}

/** A config's `severity` section can name anything; without one the value is empty. */
function severityOf(severity: string | undefined): GolangciLintDiagnostic["severity"] {
  const name = severity?.toLowerCase();
  return name === "error" || name === "info" || name === "hint" ? SEVERITY[name] : SEVERITY.warning;
}

/** The UTF-16 column of byte offset `bytes` in `line`, at most its end. */
function utf16Column(line: string, bytes: number): number {
  return Buffer.from(line, "utf8").subarray(0, bytes).toString("utf8").length;
}

function tokenEnd(line: string, start: number): number {
  const identifier = IDENTIFIER_AT_START.exec(line.slice(start))?.[0];
  if (identifier) return start + identifier.length;
  const codePoint = line.codePointAt(start);
  if (codePoint === undefined) return start;
  return start + String.fromCodePoint(codePoint).length;
}
