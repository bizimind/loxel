import { expect, test } from "bun:test";

import { git, withWorkDir } from "../test-workdir.ts";
import languages from "./languages.ts";
import loc from "./loc.ts";

const FILES = {
  ".gitignore": "coverage/\n",
  "src/index.js": "a\nb\n",
  "src/esm.mjs": "a\n",
  "src/cjs.cjs": "a\n",
  "README.md": "docs\n",
  "tools.d/Makefile": "all:\n",
  "coverage/report.js": "ignored\n",
  "node_modules/dep/index.js": "dep\n",
};

test("loc counts only source files git does not ignore", async () => {
  await withWorkDir(FILES, async (workDir) => {
    await git(workDir, "init", "-q");
    const records = await loc.generate(workDir, {});
    expect(records.map((r) => `${r.path}:${String(r.lines)}`).sort()).toEqual([
      "src/cjs.cjs:2",
      "src/esm.mjs:2",
      "src/index.js:3",
    ]);
  });
});

test("languages groups by the file name's extension and skips what git ignores", async () => {
  await withWorkDir(FILES, async (workDir) => {
    await git(workDir, "init", "-q");
    const records = await languages.generate(workDir, {});
    expect(records.map((r) => r.path).sort()).toEqual([
      "(no ext)/tools.d/Makefile",
      "cjs/src/cjs.cjs",
      "gitignore/.gitignore",
      "js/src/index.js",
      "md/README.md",
      "mjs/src/esm.mjs",
    ]);
  });
});

test("both keep working outside a git repository", async () => {
  await withWorkDir(FILES, async (workDir) => {
    const locPaths = (await loc.generate(workDir, {})).map((r) => r.path).sort();
    expect(locPaths).toContain("coverage/report.js");
    expect(locPaths).not.toContain("node_modules/dep/index.js");
    const languagePaths = (await languages.generate(workDir, {})).map((r) => r.path);
    expect(languagePaths).toContain("md/README.md");
  });
});

test("a changed .gitignore re-runs loc", () => {
  expect(loc.meta.watchGlobs.some((g) => new Bun.Glob(g).match(".gitignore"))).toBe(true);
});
