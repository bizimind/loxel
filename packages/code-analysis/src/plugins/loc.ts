import { join } from "node:path";

import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "loc",
    description: "Lines of code per source file",
    vizType: "treemap",
    watchGlobs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const proc = Bun.spawn(
      [
        "find",
        ".",
        "-type",
        "f",
        "(",
        "-name",
        "*.ts",
        "-o",
        "-name",
        "*.tsx",
        "-o",
        "-name",
        "*.js",
        "-o",
        "-name",
        "*.jsx",
        "-o",
        "-name",
        "*.mjs",
        "-o",
        "-name",
        "*.cjs",
        ")",
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/dist/*",
      ],
      { cwd: workDir, stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    const files = text.trim().split("\n").filter(Boolean);

    const records: AnalysisRecord[] = [];
    await Promise.all(
      files.map(async (rel) => {
        const abs = join(workDir, rel.replace(/^\.\//, ""));
        const content = await Bun.file(abs)
          .text()
          .catch(() => "");
        const lines = content.split("\n").length;
        records.push({ path: rel.replace(/^\.\//, ""), lines });
      }),
    );
    return records;
  },

  buildConfig(_workDir, _args): TreemapConfig {
    return {
      vizType: "treemap",
      title: "Lines of Code",
      unit: "lines",
      valueField: "lines",
      filter: {},
    };
  },
};

export default plugin;
