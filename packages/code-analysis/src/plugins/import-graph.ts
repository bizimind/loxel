import type { ICruiseResult } from "dependency-cruiser";

import { cruise } from "dependency-cruiser";
import { join } from "node:path";

import type { AnalysisPlugin, AnalysisRecord, NetworkGraphConfig } from "../plugin.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "import-graph",
    description: "Import dependency graph between source files",
    vizType: "network-graph",
    options: [
      { key: "scope", description: "root path to scope the graph (e.g. src/components)" },
      {
        key: "threshold",
        description: "imported more than N times becomes a shared module",
        default: "3",
      },
    ],
    watchGlobs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "tsconfig*.json"],
  },

  async generate(workDir, args): Promise<AnalysisRecord[]> {
    const roots = args.scope ? [join(workDir, args.scope)] : [workDir];

    const result = await cruise(roots, {
      doNotFollow: { path: "node_modules" },
      exclude: { path: ["node_modules", "\\.git", "dist"] },
      tsConfig: { fileName: join(workDir, "tsconfig.json") },
    });

    const cruiseResult = result.output as ICruiseResult;
    const records: AnalysisRecord[] = [];

    for (const mod of cruiseResult.modules) {
      if (mod.coreModule) continue;
      for (const dep of mod.dependencies) {
        if (dep.coreModule) continue;
        if (!dep.resolved) continue;
        records.push({ path: mod.source, source: mod.source, target: dep.resolved });
      }
    }

    return records;
  },

  buildConfig(_workDir, args): NetworkGraphConfig {
    return {
      vizType: "network-graph",
      title: args.scope ? `Import Graph: ${args.scope}` : "Import Graph",
      sourceField: "source",
      targetField: "target",
      threshold: parseInt(args.threshold ?? "3", 10),
    };
  },
};

export default plugin;
