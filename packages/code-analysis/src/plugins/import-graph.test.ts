import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import importGraph from "./import-graph.ts";

// Records are relative to the process cwd (like the CLI run from the analyzed tree), and
// the tmpdir is realpath'd because dependency-cruiser resolves symlinks in targets.
async function withWorkDir<T>(files: Record<string, string>, fn: (workDir: string) => Promise<T>) {
  const workDir = await realpath(await mkdtemp(join(tmpdir(), "code-analysis-import-graph-")));
  const previousCwd = process.cwd();
  try {
    await Promise.all(
      Object.entries(files).map(([name, content]) => Bun.write(join(workDir, name), content)),
    );
    process.chdir(workDir);
    return await fn(workDir);
  } finally {
    process.chdir(previousCwd);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function edges(workDir: string): Promise<string[]> {
  const records = await importGraph.generate(workDir, {});
  return records.map((record) => `${String(record.source)} -> ${String(record.target)}`).sort();
}

test("includes local imports and excludes unresolved package imports", async () => {
  await withWorkDir(
    {
      "index.ts": 'import "./local.ts";\nimport "external-package";\nimport "node:fs";\n',
      "local.ts": "export const local = true;\n",
    },
    async (workDir) => {
      expect(await edges(workDir)).toEqual(["index.ts -> local.ts"]);
    },
  );
});

test("resolves tsconfig paths aliases when the workdir has a tsconfig.json", async () => {
  await withWorkDir(
    {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/index.ts": 'import "@/lib/util.ts";\nimport "./lib/other.ts";\n',
      "src/lib/util.ts": "export const util = true;\n",
      "src/lib/other.ts": "export const other = true;\n",
    },
    async (workDir) => {
      expect(await edges(workDir)).toEqual([
        "src/index.ts -> src/lib/other.ts",
        "src/index.ts -> src/lib/util.ts",
      ]);
    },
  );
});
