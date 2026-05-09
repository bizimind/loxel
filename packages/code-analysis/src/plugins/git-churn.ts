import type { AnalysisPlugin, AnalysisRecord, TreemapConfig } from "../plugin.ts";

const plugin: AnalysisPlugin = {
  meta: {
    id: "git-churn",
    description: "Git commit churn per file (additions + deletions)",
    vizType: "treemap",
    watchGlobs: [".git/refs/**", ".git/HEAD"],
  },

  async generate(workDir, _args): Promise<AnalysisRecord[]> {
    const proc = Bun.spawn(["git", "log", "--numstat", "--pretty=format:"], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();

    const byPath = new Map<string, { additions: number; deletions: number }>();

    for (const line of text.split("\n")) {
      const parts = line.split("\t");
      if (parts.length !== 3) continue;
      const [addStr, delStr, path] = parts;
      if (!path || addStr === "-") continue; // binary files
      const additions = parseInt(addStr ?? "0", 10);
      const deletions = parseInt(delStr ?? "0", 10);
      if (isNaN(additions) || isNaN(deletions)) continue;
      const existing = byPath.get(path) ?? { additions: 0, deletions: 0 };
      byPath.set(path, {
        additions: existing.additions + additions,
        deletions: existing.deletions + deletions,
      });
    }

    return [...byPath.entries()].map(([path, { additions, deletions }]) => ({
      path,
      additions,
      deletions,
      total: additions + deletions,
    }));
  },

  buildConfig(_workDir, _args): TreemapConfig {
    return {
      vizType: "treemap",
      title: "Git Churn",
      unit: "lines changed",
      valueField: "total",
      filter: {},
    };
  },
};

export default plugin;
