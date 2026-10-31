import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDiagnostics, parseTypeScriptDiagnostics } from "./diagnostics";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const TYPE_ERROR = 'const n: number = "x";\nexport {};\n';
const JS_TYPE_ERROR = "const n = 1;\nn.nope();\nexport {};\n";
const CHECK_JS_CONFIG = JSON.stringify({ compilerOptions: { checkJs: true, types: [] } });

async function seedRepo(
  files: Record<string, string>,
  parentFiles: Record<string, string> = {},
): Promise<{ repo: string; sha: string; base: string }> {
  const base = mkdtempSync(path.join(tmpdir(), "diag-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(parentFiles)) {
    await Bun.write(path.join(base, name), content);
  }
  const repo = path.join(base, "repo");
  await Bun.$`git init -q -b main ${repo}`.quiet();
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(path.join(repo, name), content);
  }
  await Bun.$`git -C ${repo} add -A`.quiet();
  await Bun.$`git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m init`.quiet();
  const sha = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  return { repo, sha, base };
}

describe("getDiagnostics", () => {
  test("skips a working tree without a root config", async () => {
    // tsc would otherwise fall back to the ancestor tsconfig and report a.ts.
    const { repo } = await seedRepo(
      { "main.py": "x = 1\n", "a.ts": TYPE_ERROR },
      { "tsconfig.json": JSON.stringify({ include: ["**/*.ts"], compilerOptions: { types: [] } }) },
    );
    expect(await getDiagnostics(repo, undefined)).toEqual([]);
  });

  test("skips the temp checkout for a ref without a root config", async () => {
    const { repo, sha, base } = await seedRepo({ "main.py": "x = 1\n", "a.ts": TYPE_ERROR });
    // Any checkout (the temp worktree) runs this hook and leaves a marker.
    const marker = path.join(base, "checked-out");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    await Bun.write(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);

    expect(await getDiagnostics(repo, sha)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test("rejects an unknown ref instead of caching it as empty", async () => {
    const { repo } = await seedRepo({ "main.py": "x = 1\n" });
    await expect(getDiagnostics(repo, "deadbeefdeadbeef")).rejects.toThrow();
    await expect(getDiagnostics(repo, "deadbeefdeadbeef")).rejects.toThrow();
  });

  test("runs tsc for a working tree with a root tsconfig", async () => {
    const { repo } = await seedRepo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
      "a.ts": TYPE_ERROR,
    });
    const diagnostics = await getDiagnostics(repo, undefined);
    expect(diagnostics).toEqual([
      expect.objectContaining({ file: "a.ts", line: 1, severity: "error", code: 2322 }),
    ]);
  });

  test("runs tsc for a working tree with only a root jsconfig", async () => {
    const { repo } = await seedRepo({ "jsconfig.json": CHECK_JS_CONFIG, "a.js": JS_TYPE_ERROR });
    expect(await getDiagnostics(repo, undefined)).toEqual([
      expect.objectContaining({ file: "a.js", line: 2, severity: "error", code: 2339 }),
    ]);
  });

  test("runs tsc for a ref with only a root jsconfig", async () => {
    const { repo, sha } = await seedRepo({
      "jsconfig.json": CHECK_JS_CONFIG,
      "a.js": JS_TYPE_ERROR,
    });
    expect(await getDiagnostics(repo, sha)).toEqual([
      expect.objectContaining({ file: "a.js", line: 2, severity: "error", code: 2339 }),
    ]);
  });

  test("a root tsconfig wins over a root jsconfig, in the working tree and a ref", async () => {
    const { repo, sha } = await seedRepo({
      "tsconfig.json": JSON.stringify({ include: ["a.ts"], compilerOptions: { types: [] } }),
      "jsconfig.json": JSON.stringify({
        include: ["b.js"],
        compilerOptions: { checkJs: true, types: [] },
      }),
      "a.ts": TYPE_ERROR,
      "b.js": JS_TYPE_ERROR,
    });
    const expected = [expect.objectContaining({ file: "a.ts", code: 2322 })];
    expect(await getDiagnostics(repo, undefined)).toEqual(expected);
    expect(await getDiagnostics(repo, sha)).toEqual(expected);
  });

  test("reports only syntax errors in JS a jsconfig doesn't check", async () => {
    const { repo } = await seedRepo({
      "jsconfig.json": JSON.stringify({ compilerOptions: { types: [] } }),
      "a.js": JS_TYPE_ERROR,
      "b.js": "const x = ;\n",
    });
    expect(await getDiagnostics(repo, undefined)).toEqual([
      expect.objectContaining({ file: "b.js", code: 1109 }),
    ]);
  });

  test("reports a jsconfig's removed options against the jsconfig, ahead of type errors", async () => {
    const { repo } = await seedRepo({
      "jsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", checkJs: true, types: [] },
      }),
      "a.js": JS_TYPE_ERROR,
    });
    expect(await getDiagnostics(repo, undefined)).toEqual([
      expect.objectContaining({ file: "jsconfig.json", severity: "error", code: 5102 }),
    ]);
  });

  test("leaves out the JS dependencies a jsconfig checks, in a ref's temp checkout too", async () => {
    const { repo, sha } = await seedRepo({
      ".gitignore": "node_modules\n",
      "jsconfig.json": CHECK_JS_CONFIG,
      "a.js": 'import "dep";\nconst n = 1;\nn.nope();\n',
    });
    await Bun.write(path.join(repo, "node_modules", "dep", "index.js"), JS_TYPE_ERROR);
    await Bun.write(path.join(repo, "node_modules", "dep", "package.json"), '{"name":"dep"}');
    const expected = [expect.objectContaining({ file: "a.js", code: 2339 })];
    expect(await getDiagnostics(repo, undefined)).toEqual(expected);
    expect(await getDiagnostics(repo, sha)).toEqual(expected);
  });
});

describe("parseTypeScriptDiagnostics", () => {
  const line = (file: string) => `${file}(1,1): error TS2322: Nope.`;

  test("skips node_modules at any depth, and keeps names that only look like it", () => {
    const output = [
      line("node_modules/dep/index.js"),
      line("packages/app/node_modules/dep/index.js"),
      line("../../source/node_modules/dep/index.js"),
      line("node_modules_extra/a.js"),
    ].join("\n");
    expect(parseTypeScriptDiagnostics(output, "/repo/wt").map((d) => d.file)).toEqual([
      "node_modules_extra/a.js",
    ]);
  });
});
