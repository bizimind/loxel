import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "disk-utilization",
    description: "Disk space used per file",
    vizType: "treemap",
    watchGlobs: ["**/*"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const proc = Bun.spawn(
      ["find", ".", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
      { cwd: workDir, stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    const files = text.trim().split("\n").filter(Boolean);

    const records: AnalysisRecord[] = [];
    await Promise.all(
      files.map(async (rel) => {
        const clean = rel.replace(/^\.\//, "");
        const f = Bun.file(`${workDir}/${clean}`);
        const bytes: number | null = await f
          .exists()
          .then((ok) => (ok ? f.size : null))
          .catch(() => null);
        if (bytes === null) return;
        records.push({ path: clean, bytes });
      }),
    );
    return records;
  },

  buildConfig(_workDir, _args): TreemapConfig {
    return {
      vizType: "treemap",
      title: "Disk Utilization",
      unit: "bytes",
      valueField: "bytes",
      filter: {},
    };
  },
};

export default plugin;
