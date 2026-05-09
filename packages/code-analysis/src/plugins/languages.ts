import { join } from "node:path";

import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "languages",
    description: "File size by language/extension",
    vizType: "treemap",
    watchGlobs: ["**/*"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const proc = Bun.spawn(
      [
        "find",
        ".",
        "-type",
        "f",
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
        const clean = rel.replace(/^\.\//, "");
        const abs = join(workDir, clean);
        const f = Bun.file(abs);
        const stat: number | null = await f
          .exists()
          .then((ok) => (ok ? f.size : null))
          .catch(() => null);
        if (stat === null) return;
        const dotIdx = clean.lastIndexOf(".");
        const ext = dotIdx !== -1 ? clean.slice(dotIdx + 1) : "(no ext)";
        records.push({ path: `${ext}/${clean}`, bytes: stat, ext });
      }),
    );
    return records;
  },

  buildConfig(_workDir, _args): TreemapConfig {
    return {
      vizType: "treemap",
      title: "File Size by Language",
      unit: "bytes",
      valueField: "bytes",
      filter: {},
    };
  },
};

export default plugin;
