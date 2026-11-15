import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";
import { findInstalledBin, SOURCE_GLOBS } from "../project.ts";

function isOxlintOutput(
  v: unknown,
): v is { diagnostics: Array<{ filename: string; code: string; severity: string }> } {
  return (
    typeof v === "object" &&
    v !== null &&
    "diagnostics" in v &&
    Array.isArray((v as Record<string, unknown>).diagnostics)
  );
}

function isEslintOutput(
  v: unknown,
): v is Array<{ filePath: string; messages: Array<{ ruleId: string | null; severity: number }> }> {
  return (
    Array.isArray(v) &&
    (v.length === 0 || (typeof v[0] === "object" && v[0] !== null && "filePath" in v[0]))
  );
}

const plugin: AnalysisPlugin = {
  meta: {
    id: "lint-issues",
    description: "Lint violations per file",
    vizType: "treemap",
    options: [{ key: "rule", description: "rule name to filter (e.g. no-console)" }],
    watchGlobs: [...SOURCE_GLOBS, ".eslintrc*", "eslint.config*", ".oxlintrc*"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const oxlint = findInstalledBin(workDir, "oxlint");
    const eslint = findInstalledBin(workDir, "eslint");
    if (!oxlint && !eslint) {
      process.stderr.write(
        "[code-analysis] lint-issues: no results, this project has no linter installed. " +
          "Install `oxlint` or `eslint` to check it.\n",
      );
      return [];
    }
    // Try oxlint first, fall back to eslint.
    const records =
      (oxlint ? await tryOxlint(workDir, oxlint) : null) ??
      (eslint ? await tryEslint(workDir, eslint) : null);
    if (!records) {
      process.stderr.write(
        "[code-analysis] lint-issues: no results, no installed linter gave usable output.\n",
      );
      return [];
    }
    return records;
  },

  buildConfig(_workDir, args): TreemapConfig {
    return {
      vizType: "treemap",
      title: args.rule ? `Lint Issues: ${args.rule}` : "Lint Issues",
      unit: "violations",
      valueField: "count",
      filter: args.rule ? { rule: args.rule } : {},
    };
  },
};

// Null when the linter did not produce JSON, for example because it found no config.
async function runLinter(workDir: string, bin: string): Promise<unknown> {
  const proc = Bun.spawn([bin, "-f", "json", "."], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  try {
    return JSON.parse(stdout);
  } catch {
    process.stderr.write(`[code-analysis] lint-issues: ${bin} failed:\n${stderr.trim()}\n`);
    return null;
  }
}

async function tryOxlint(workDir: string, bin: string): Promise<AnalysisRecord[] | null> {
  const parsed = await runLinter(workDir, bin);
  if (!isOxlintOutput(parsed)) return null;

  return parsed.diagnostics.map((d) => ({
    path: d.filename,
    rule: d.code,
    severity: d.severity,
    count: 1,
  }));
}

async function tryEslint(workDir: string, bin: string): Promise<AnalysisRecord[] | null> {
  const parsed = await runLinter(workDir, bin);
  if (!isEslintOutput(parsed)) return null;

  const records: AnalysisRecord[] = [];
  for (const file of parsed) {
    for (const msg of file.messages) {
      records.push({
        path: file.filePath.replace(workDir + "/", ""),
        rule: msg.ruleId ?? "(unknown)",
        severity: msg.severity === 2 ? "error" : "warning",
        count: 1,
      });
    }
  }
  return records;
}

export default plugin;
