import { basename } from "node:path";

import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";
import { listProjectFiles } from "../project.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "languages",
    description: "File size by language/extension",
    vizType: "treemap",
    watchGlobs: ["**/*"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const files = await listProjectFiles(workDir);
    return files.map(({ path, bytes }) => {
      const name = basename(path);
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx !== -1 ? name.slice(dotIdx + 1) : "(no ext)";
      return { path: `${ext}/${path}`, bytes, ext };
    });
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
