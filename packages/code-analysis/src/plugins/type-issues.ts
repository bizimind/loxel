import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";

// Matches: path/to/file.ts(line,col): error TS1234: message
const DIAG_RE = /^(.+?)\((\d+),\d+\):\s+\w+\s+(TS\d+):\s+(.+)$/;

const plugin: AnalysisPlugin = {
  meta: {
    id: "type-issues",
    description: "TypeScript type errors per file",
    vizType: "treemap",
    options: [{ key: "code", description: "TS error code to filter (e.g. TS2345)" }],
    watchGlobs: ["**/*.ts", "**/*.tsx", "tsconfig*.json"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    // TypeScript 7 renamed the native compiler to tsc. Keep the preview-era name as
    // a fallback for projects that still install @typescript/native-preview.
    const records =
      (await runTypeChecker(workDir, "tsc")) ?? (await runTypeChecker(workDir, "tsgo"));
    return records ?? [];
  },

  buildConfig(_workDir, args): TreemapConfig {
    return {
      vizType: "treemap",
      title: args.code ? `Type Issues: ${args.code}` : "Type Issues",
      unit: "errors",
      valueField: "count",
      filter: args.code ? { code: args.code } : {},
    };
  },
};

async function runTypeChecker(workDir: string, bin: string): Promise<AnalysisRecord[] | null> {
  const proc = Bun.spawn(["bunx", bin, "--noEmit", "--pretty", "false"], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  // tsc/tsgo write diagnostics to stdout; mix both just in case.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  // If the binary didn't exist, output will be empty or contain "command not found".
  const combined = stdout + stderr;
  if (combined.includes("command not found")) return null;
  if (exitCode === 0) return [];

  const records: AnalysisRecord[] = [];
  for (const line of combined.split("\n")) {
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const [, filePath, , code, message] = m;
    if (!filePath || !code) continue;
    records.push({
      path: filePath.replace(workDir + "/", ""),
      code,
      message: message ?? "",
      count: 1,
    });
  }
  return records.length > 0 ? records : null;
}

export default plugin;
