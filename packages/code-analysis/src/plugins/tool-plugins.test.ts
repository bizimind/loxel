import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { git, installFakeBin, withWorkDir } from "../test-workdir.ts";
import lintIssues from "./lint-issues.ts";
import typeIssues from "./type-issues.ts";

const REAL_TSC = join(import.meta.dir, "../../../../node_modules/.bin/tsc");

const stderrSpy = spyOn(process.stderr, "write");

afterEach(() => {
  stderrSpy.mockClear();
});

function stderrOutput(): string {
  return stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

test("with nothing installed, neither plugin spawns anything and both say why", async () => {
  await withWorkDir({ "tsconfig.json": "{}", "a.js": "" }, async (workDir) => {
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      expect(await typeIssues.generate(workDir, {})).toEqual([]);
      expect(stderrOutput()).toContain("no TypeScript compiler installed");
      expect(await lintIssues.generate(workDir, {})).toEqual([]);
      expect(stderrOutput()).toContain("no linter installed");
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

test("type-issues says when the project has no tsconfig or jsconfig", async () => {
  await withWorkDir({ "a.js": "" }, async (workDir) => {
    await installFakeBin(workDir, "tsc", "exit 1");
    expect(await typeIssues.generate(workDir, {})).toEqual([]);
    expect(stderrOutput()).toContain("no tsconfig.json or jsconfig.json");
  });
});

test("type-issues checks a jsconfig-only project with the real compiler", async () => {
  await withWorkDir(
    {
      "jsconfig.json": JSON.stringify({
        compilerOptions: { checkJs: true, module: "nodenext", target: "es2022", noEmit: true },
      }),
      "src/index.mjs": 'import "dep";\n/** @type {number} */\nexport const n = "text";\n',
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", main: "index.js" }),
      "node_modules/dep/index.js": '/** @type {number} */\nmodule.exports = "text";\n',
    },
    async (workDir) => {
      await mkdir(join(workDir, "node_modules/.bin"));
      await symlink(REAL_TSC, join(workDir, "node_modules/.bin/tsc"));
      const records = await typeIssues.generate(workDir, {});
      expect(records.map((r) => [r.path, r.code])).toEqual([["src/index.mjs", "TS2322"]]);
    },
  );
});

test("type-issues passes tsconfig.json when both configs exist", async () => {
  await withWorkDir({ "tsconfig.json": "{}", "jsconfig.json": "{}" }, async (workDir) => {
    await installFakeBin(workDir, "tsc", 'echo "src/a.js(1,1): error TS1: $5"; exit 1');
    const records = await typeIssues.generate(workDir, {});
    expect(records[0]?.message).toBe(join(workDir, "tsconfig.json"));
  });
});

test("type-issues reports errors only in dependencies as no project errors", async () => {
  await withWorkDir({ "jsconfig.json": "{}" }, async (workDir) => {
    const diagnostic = "node_modules/dep/index.js(1,1): error TS1: bad";
    await installFakeBin(workDir, "tsc", `echo "${diagnostic}"; exit 1`);
    expect(await typeIssues.generate(workDir, {})).toEqual([]);
    expect(stderrOutput()).toBe("");
  });
});

test("type-issues does not count errors outside the workdir", async () => {
  await withWorkDir({ "tsconfig.json": "{}", "packages/app/a.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    const output = "../other/b.js(1,1): error TS1: sibling\na.js(1,1): error TS2: own";
    await installFakeBin(workDir, "tsc", `echo "${output}"; exit 1`);
    const records = await typeIssues.generate(join(workDir, "packages/app"), {});
    expect(records.map((r) => r.path)).toEqual(["a.js"]);
  });
});

test("type-issues surfaces a compiler failure with no diagnostics", async () => {
  await withWorkDir({ "tsconfig.json": "{}" }, async (workDir) => {
    await installFakeBin(workDir, "tsc", 'echo "error TS5023: Unknown option"; exit 1');
    expect(await typeIssues.generate(workDir, {})).toEqual([]);
    expect(stderrOutput()).toContain("error TS5023: Unknown option");
  });
});

test("type-issues falls back to an installed tsgo", async () => {
  await withWorkDir({ "tsconfig.json": "{}" }, async (workDir) => {
    await installFakeBin(workDir, "tsgo", 'echo "a.ts(1,1): error TS2: tsgo ran"; exit 1');
    const records = await typeIssues.generate(workDir, {});
    expect(records.map((r) => r.message)).toEqual(["tsgo ran"]);
  });
});

test("lint-issues runs the project's oxlint", async () => {
  await withWorkDir({}, async (workDir) => {
    const output = JSON.stringify({
      diagnostics: [{ filename: "a.mjs", code: "no-console", severity: "error" }],
    });
    await installFakeBin(workDir, "oxlint", `echo '${output}'`);
    const records = await lintIssues.generate(workDir, {});
    expect(records.map((r) => [r.path, r.rule])).toEqual([["a.mjs", "no-console"]]);
  });
});

test("lint-issues falls back to the project's eslint when oxlint fails, and says so", async () => {
  await withWorkDir({}, async (workDir) => {
    const output = JSON.stringify([
      { filePath: join(workDir, "a.cjs"), messages: [{ ruleId: "semi", severity: 2 }] },
    ]);
    await installFakeBin(workDir, "oxlint", 'echo "oxlint broke" >&2; exit 2');
    await installFakeBin(workDir, "eslint", `echo '${output}'; exit 1`);
    const records = await lintIssues.generate(workDir, {});
    expect(records.map((r) => [r.path, r.rule])).toEqual([["a.cjs", "semi"]]);
    expect(stderrOutput()).toContain("oxlint broke");
  });
});

test("lint-issues says so when the linter's JSON is not in the expected shape", async () => {
  await withWorkDir({}, async (workDir) => {
    await installFakeBin(workDir, "oxlint", `echo '[{"x":1}]'; exit 1`);
    expect(await lintIssues.generate(workDir, {})).toEqual([]);
    expect(stderrOutput()).toContain("no installed linter gave usable output");
  });
});

test("plain JS sources and jsconfig trigger a re-run", () => {
  const matches = (globs: string[], file: string) => globs.some((g) => new Bun.Glob(g).match(file));
  for (const file of ["a.js", "lib/a.mjs", "lib/a.cjs", "a.jsx"]) {
    expect(matches(typeIssues.meta.watchGlobs, file)).toBe(true);
    expect(matches(lintIssues.meta.watchGlobs, file)).toBe(true);
  }
  expect(matches(typeIssues.meta.watchGlobs, "jsconfig.json")).toBe(true);
});
