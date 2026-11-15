import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";
import { findInstalledBin, findProjectConfig, SOURCE_GLOBS } from "../project.ts";

// Matches: path/to/file.ts(line,col): error TS1234: message
const DIAG_RE = /^(.+?)\((\d+),\d+\):\s+\w+\s+(TS\d+):\s+(.+)$/;

const plugin: AnalysisPlugin = {
  meta: {
    id: "type-issues",
    description: "TypeScript type errors per file",
    vizType: "treemap",
    options: [{ key: "code", description: "TS error code to filter (e.g. TS2345)" }],
    watchGlobs: [...SOURCE_GLOBS, "tsconfig*.json", "jsconfig*.json"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    // TypeScript 7 renamed the native compiler to tsc. Keep the preview-era name as
    // a fallback for projects that still install @typescript/native-preview.
    const bin = findInstalledBin(workDir, "tsc") ?? findInstalledBin(workDir, "tsgo");
    if (!bin) {
      process.stderr.write(
        "[code-analysis] type-issues: no results, this project has no TypeScript compiler " +
          "installed. Install the `typescript` package to check it.\n",
      );
      return [];
    }
    // A bare `tsc` only looks for a tsconfig.json, and prints its help without one.
    const config = findProjectConfig(workDir);
    if (!config) {
      process.stderr.write(
        "[code-analysis] type-issues: no results, this project has no tsconfig.json or " +
          "jsconfig.json.\n",
      );
      return [];
    }
    return runTypeChecker(workDir, bin, config);
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

async function runTypeChecker(
  workDir: string,
  bin: string,
  config: string,
): Promise<AnalysisRecord[]> {
  const proc = Bun.spawn([bin, "--noEmit", "--pretty", "false", "-p", config], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  // tsc/tsgo write diagnostics to stdout; mix both just in case.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return [];

  const combined = stdout + stderr;
  const diagnostics = combined.split("\n").flatMap((line) => {
    const m = DIAG_RE.exec(line);
    return m ? [m] : [];
  });
  if (diagnostics.length === 0) {
    process.stderr.write(
      `[code-analysis] type-issues: no results, ${bin} failed:\n${combined.trim()}\n`,
    );
    return [];
  }

  const records: AnalysisRecord[] = [];
  for (const [, filePath, , code, message] of diagnostics) {
    if (!filePath || !code) continue;
    // A jsconfig.json defaults to maxNodeModuleJsDepth 2, so tsc also reports errors inside
    // JS dependencies. They are not the project's to fix.
    if (filePath.split("/").includes("node_modules")) continue;
    // A config in a parent directory also covers files outside workDir.
    if (filePath.startsWith("../")) continue;
    records.push({
      path: filePath.replace(workDir + "/", ""),
      code,
      message: message ?? "",
      count: 1,
    });
  }
  return records;
}

export default plugin;
