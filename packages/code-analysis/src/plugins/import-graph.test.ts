import { expect, test } from "bun:test";
import { join } from "node:path";

import { withWorkDir } from "../test-workdir.ts";
import importGraph from "./import-graph.ts";

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

test("resolves jsconfig paths aliases when the workdir has only a jsconfig.json", async () => {
  await withWorkDir(
    {
      "jsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/index.js": 'import "@/lib/util";\nimport "@/lib/esm.mjs";\nimport "@/lib/cjs.cjs";\n',
      "src/lib/util.js": "export const util = true;\n",
      "src/lib/esm.mjs": "export const esm = true;\n",
      "src/lib/cjs.cjs": "module.exports = {};\n",
    },
    async (workDir) => {
      expect(await edges(workDir)).toEqual([
        "src/index.js -> src/lib/cjs.cjs",
        "src/index.js -> src/lib/esm.mjs",
        "src/index.js -> src/lib/util.js",
      ]);
    },
  );
});

test("prefers tsconfig.json over jsconfig.json in the same directory", async () => {
  await withWorkDir(
    {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./ts/*"] } } }),
      "jsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./js/*"] } } }),
      "index.js": 'import "@/util.js";\n',
      "ts/util.js": "export {};\n",
      "js/util.js": "export {};\n",
    },
    async (workDir) => {
      expect(await edges(workDir)).toEqual(["index.js -> ts/util.js"]);
    },
  );
});

test("reports paths relative to the workdir, whatever the process cwd", async () => {
  await withWorkDir({ "a.js": 'import "./b.js";\n', "b.js": "" }, async (workDir) => {
    expect(process.cwd()).not.toBe(workDir);
    expect(await edges(workDir)).toEqual(["a.js -> b.js"]);
  });
});

test("excludes whole path segments, not names that merely contain them", async () => {
  await withWorkDir(
    {
      "index.js":
        'import "./distance.js";\nimport "./.github/helper.js";\nimport "./dist/out.js";\n',
      "distance.js": "",
      ".github/helper.js": "",
      "dist/out.js": "",
    },
    async (workDir) => {
      expect(await edges(workDir)).toEqual([
        "index.js -> .github/helper.js",
        "index.js -> distance.js",
      ]);
    },
  );
});

test("scopes the graph to a subdirectory", async () => {
  await withWorkDir(
    {
      "src/a.js": 'import "./b.js";\n',
      "src/b.js": "",
      "other/c.js": 'import "./d.js";\n',
      "other/d.js": "",
    },
    async (workDir) => {
      const records = await importGraph.generate(workDir, { scope: "src" });
      expect(records.map((r) => r.source)).toEqual(["src/a.js"]);
    },
  );
});

test("resolves aliases from a config in a parent directory", async () => {
  await withWorkDir(
    {
      "jsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./shared/*"] } } }),
      ".git/HEAD": "",
      "packages/app/index.js": 'import "./local.js";\nimport "@/util.js";\n',
      "packages/app/local.js": "",
      "shared/util.js": "",
    },
    async (workDir) => {
      expect(await edges(join(workDir, "packages/app"))).toEqual([
        "index.js -> ../../shared/util.js",
        "index.js -> local.js",
      ]);
    },
  );
});
