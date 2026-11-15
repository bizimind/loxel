import { expect, test } from "bun:test";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { findInstalledBin, findProjectConfig, listProjectFiles } from "./project.ts";
import { git, installFakeBin, withWorkDir } from "./test-workdir.ts";

async function listedPaths(workDir: string): Promise<string[]> {
  return (await listProjectFiles(workDir)).map((file) => file.path).sort();
}

test("in a git repository, lists tracked and untracked files but not ignored ones", async () => {
  await withWorkDir(
    {
      ".gitignore": "build/\n",
      "tracked.js": "1\n",
      "untracked.js": "2\n",
      "dist/tracked-output.js": "3\n",
      "build/ignored.js": "4\n",
    },
    async (workDir) => {
      await git(workDir, "init", "-q");
      await git(workDir, "add", ".gitignore", "tracked.js", "dist/tracked-output.js");
      expect(await listedPaths(workDir)).toEqual([
        ".gitignore",
        "dist/tracked-output.js",
        "tracked.js",
        "untracked.js",
      ]);
    },
  );
});

test("does not list node_modules when the repository has not ignored it", async () => {
  await withWorkDir({ "a.js": "", "node_modules/dep/index.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    expect(await listedPaths(workDir)).toEqual(["a.js"]);
  });
});

test("skips deleted files, symlinks and submodule-like nested repositories", async () => {
  await withWorkDir({ "kept.js": "", "deleted.js": "", "nested/inner.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    await git(workDir, "add", "kept.js", "deleted.js");
    await git(join(workDir, "nested"), "init", "-q");
    await rm(join(workDir, "deleted.js"));
    await symlink(join(workDir, "kept.js"), join(workDir, "link.js"));
    expect(await listedPaths(workDir)).toEqual(["kept.js"]);
  });
});

test("handles file names git would otherwise quote", async () => {
  await withWorkDir({ "שלום עולם.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    expect(await listedPaths(workDir)).toEqual(["שלום עולם.js"]);
  });
});

test("lists a merge-conflicted file once", async () => {
  await withWorkDir({ "a.js": "base\n" }, async (workDir) => {
    await git(workDir, "init", "-q", "-b", "main");
    await git(workDir, "config", "user.email", "test@example.com");
    await git(workDir, "config", "user.name", "test");
    await git(workDir, "add", ".");
    await git(workDir, "commit", "-qm", "base");
    await git(workDir, "checkout", "-qb", "other");
    await Bun.write(join(workDir, "a.js"), "other\n");
    await git(workDir, "commit", "-qam", "other");
    await git(workDir, "checkout", "-q", "main");
    await Bun.write(join(workDir, "a.js"), "main\n");
    await git(workDir, "commit", "-qam", "main");
    await git(workDir, "merge", "other").catch(() => undefined);
    expect(await listedPaths(workDir)).toEqual(["a.js"]);
  });
});

test("outside a git repository, lists every file except the excluded directories", async () => {
  await withWorkDir(
    { "a.js": "", "sub/b.md": "", "node_modules/dep/index.js": "", "dist/out.js": "" },
    async (workDir) => {
      expect(await listedPaths(workDir)).toEqual(["a.js", "sub/b.md"]);
    },
  );
});

test("does not start an fsmonitor named by the repository's config", async () => {
  await withWorkDir({ "a.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    await git(workDir, "add", "a.js");
    const marker = join(workDir, "marker");
    const hook = await installFakeBin(workDir, "hook", `touch "${marker}"`);
    await git(workDir, "config", "core.fsmonitor", hook);
    await listProjectFiles(workDir);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("lists the files of a workdir git ignores, with the find excludes", async () => {
  await withWorkDir(
    { ".gitignore": "build/\n", "build/out.js": "", "build/node_modules/dep.js": "" },
    async (workDir) => {
      await git(workDir, "init", "-q");
      expect(await listedPaths(join(workDir, "build"))).toEqual(["out.js"]);
    },
  );
});

test("does not take a non-executable file or a directory for a tool", async () => {
  await withWorkDir(
    { "node_modules/.bin/tsc": "", "node_modules/.bin/eslint/x": "" },
    async (workDir) => {
      expect(findInstalledBin(workDir, "tsc")).toBeNull();
      expect(findInstalledBin(workDir, "eslint")).toBeNull();
    },
  );
});

test("finds a tool at the repository root from a subdirectory", async () => {
  await withWorkDir({ "packages/app/a.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    const bin = await installFakeBin(workDir, "tsc", "true");
    expect(findInstalledBin(join(workDir, "packages/app"), "tsc")).toBe(bin);
    expect(findInstalledBin(join(workDir, "packages/app"), "eslint")).toBeNull();
  });
});

test("outside a git repository, finds neither tools nor configs in a parent directory", async () => {
  await withWorkDir({ "tsconfig.json": "{}", "sub/a.js": "" }, async (workDir) => {
    await installFakeBin(workDir, "tsc", "true");
    expect(findInstalledBin(join(workDir, "sub"), "tsc")).toBeNull();
    expect(findProjectConfig(join(workDir, "sub"))).toBeNull();
  });
});

test("the nearest config wins, and tsconfig wins within one directory", async () => {
  await withWorkDir(
    { "tsconfig.json": "{}", "jsconfig.json": "{}", "sub/jsconfig.json": "{}" },
    async (workDir) => {
      await git(workDir, "init", "-q");
      expect(findProjectConfig(workDir)).toBe(join(workDir, "tsconfig.json"));
      expect(findProjectConfig(join(workDir, "sub"))).toBe(join(workDir, "sub/jsconfig.json"));
    },
  );
});
