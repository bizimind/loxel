import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";

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
    watchGlobs: [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx",
      ".eslintrc*",
      "eslint.config*",
      ".oxlintrc*",
    ],
  },

  async generate(workDir, args): Promise<AnalysisRecord[]> {
    // Try oxlint first, fall back to eslint.
    const records = (await tryOxlint(workDir, args)) ?? (await tryEslint(workDir, args));
    return records ?? [];
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

async function tryOxlint(
  workDir: string,
  _args: Record<string, string>,
): Promise<AnalysisRecord[] | null> {
  const proc = Bun.spawn(["bunx", "oxlint", "-f", "json", "."], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isOxlintOutput(parsed)) return null;

  return parsed.diagnostics.map((d) => ({
    path: d.filename,
    rule: d.code,
    severity: d.severity,
    count: 1,
  }));
}

async function tryEslint(
  workDir: string,
  _args: Record<string, string>,
): Promise<AnalysisRecord[] | null> {
  const proc = Bun.spawn(["bunx", "eslint", "-f", "json", "."], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
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
