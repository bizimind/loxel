import { createResult, runAction } from "@bizimind/cli-common";

import { diagnose, type Check, type CheckStatus, type Diagnosis } from "../lib/index.ts";

interface DoctorOptions {
  json?: boolean;
}

/** Report the repository's setup checks without changing anything. Exits 1 when one fails. */
export async function doctorCommand(options: DoctorOptions): Promise<void> {
  await runAction<Diagnosis>(options, async () => {
    const diagnosis = await diagnose(process.cwd());
    return createResult(diagnosis, formatDiagnosis, diagnosis.ok ? 0 : 1);
  });
}

function formatDiagnosis(diagnosis: Diagnosis): string {
  const lines = [
    `Repository: ${diagnosis.root}${diagnosis.bare ? " (bare)" : ""}`,
    "",
    formatChecks(diagnosis.checks),
  ];
  if (diagnosis.checks.some((check) => check.fixable && check.status !== "ok")) {
    lines.push("", "Run 'wt init' to review the fixes.");
  }
  return lines.join("\n");
}

const STATUS_SYMBOL: Record<CheckStatus, string> = { ok: "✓", info: "i", warn: "!", fail: "✗" };

/** One line per check, with what a non-ok check affects indented below it. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((check) => check.title.length));
  return checks
    .flatMap((check) => [
      `${STATUS_SYMBOL[check.status]} ${check.title.padEnd(width)}  ${check.summary}`,
      ...(check.status === "ok"
        ? []
        : check.affects.map((line) => `  ${" ".repeat(width)}  - ${line}`)),
    ])
    .join("\n");
}

/** A check's status symbol and title, for one-line references. */
export function checkLabel(check: Check): string {
  return `${STATUS_SYMBOL[check.status]} ${check.title}`;
}
