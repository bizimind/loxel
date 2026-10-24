import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDiagnostics } from "./diagnostics";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const TYPE_ERROR = 'const n: number = "x";\nexport {};\n';

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
  test("skips a working tree without a root tsconfig", async () => {
    // tsc would otherwise fall back to the ancestor tsconfig and report a.ts.
    const { repo } = await seedRepo(
      { "main.py": "x = 1\n", "a.ts": TYPE_ERROR },
      { "tsconfig.json": JSON.stringify({ include: ["**/*.ts"], compilerOptions: { types: [] } }) },
    );
    expect(await getDiagnostics(repo, undefined)).toEqual([]);
  });

  test("skips the temp checkout for a ref without a root tsconfig", async () => {
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
});
