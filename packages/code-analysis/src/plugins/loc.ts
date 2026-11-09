import { extname, join } from "node:path";

import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";
import { listProjectFiles, SOURCE_EXTENSIONS, SOURCE_GLOBS } from "../project.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "loc",
    description: "Lines of code per source file",
    vizType: "treemap",
    watchGlobs: [...SOURCE_GLOBS, "**/.gitignore"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const files = await listProjectFiles(workDir);
    const sources = files.filter(({ path }) => SOURCE_EXTENSIONS.includes(extname(path).slice(1)));

    const records: AnalysisRecord[] = [];
    await Promise.all(
      sources.map(async ({ path }) => {
        const content = await Bun.file(join(workDir, path))
          .text()
          .catch(() => null);
        if (content === null) return;
        records.push({ path, lines: content.split("\n").length });
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
