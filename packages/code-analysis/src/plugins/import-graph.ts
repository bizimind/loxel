import { dirname } from "node:path";

import type { ICruiseResult } from "dependency-cruiser";
import { cruise } from "dependency-cruiser";

import type { AnalysisPlugin, AnalysisRecord, NetworkGraphConfig } from "../plugin.ts";
import { findProjectConfig, SOURCE_GLOBS } from "../project.ts";

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
    watchGlobs: [...SOURCE_GLOBS, "tsconfig*.json", "jsconfig*.json"],
  },

  async generate(workDir, args): Promise<AnalysisRecord[]> {
    // dependency-cruiser only honors `paths` aliases when given a config explicitly, and
    // throws when the given file does not exist.
    const config = findProjectConfig(workDir);

    const result = await cruise(
      [args.scope ?? "."],
      {
        baseDir: workDir,
        doNotFollow: { path: "node_modules" },
        exclude: { path: "(^|/)(node_modules|\\.git|dist)(/|$)" },
        ...(config ? { tsConfig: { fileName: config } } : {}),
      },
      {},
      // Without a baseUrl here, dependency-cruiser resolves aliases from the process cwd
      // instead of from the config. It only checks that one is set; the plugin it passes the
      // config to works out the real one.
      config ? { tsConfig: { options: { baseUrl: dirname(config) } } } : {},
    );

    const cruiseResult = result.output as ICruiseResult;
    const records: AnalysisRecord[] = [];

    for (const mod of cruiseResult.modules) {
      if (mod.coreModule) continue;
      for (const dep of mod.dependencies) {
        if (dep.coreModule) continue;
        if (dep.couldNotResolve) continue;
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
