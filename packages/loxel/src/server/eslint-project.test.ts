import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  eslintNotInstalledMessage,
  findEslintConfigDir,
  hasInstalledEslint,
} from "./eslint-project";

let wt: string;

function write(rel: string, text = ""): string {
  const file = path.join(wt, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  wt = realpathSync(mkdtempSync(path.join(tmpdir(), "eslint-project-")));
});

afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
});

describe("findEslintConfigDir", () => {
  test.each([
    "eslint.config.ts",
    "eslint.config.mjs",
    ".eslintrc",
    ".eslintrc.yml",
    ".eslintrc.cjs",
  ])("finds %s above the file", (config) => {
    write(config);
    expect(findEslintConfigDir(write("src/deep/a.js"), wt)).toBe(wt);
  });

  test("the nearest config wins, and a package.json without one does not stop the walk", () => {
    write("eslint.config.js");
    write("packages/app/package.json", "{}");
    write("packages/lib/eslint.config.js");
    expect(findEslintConfigDir(write("packages/app/src/a.js"), wt)).toBe(wt);
    expect(findEslintConfigDir(write("packages/lib/src/b.js"), wt)).toBe(
      path.join(wt, "packages/lib"),
    );
  });

  test("an eslintConfig key in package.json counts", () => {
    write("package.json", JSON.stringify({ eslintConfig: { root: true } }));
    expect(findEslintConfigDir(write("a.js"), wt)).toBe(wt);
  });

  test("no config, or a directory by that name, is none", () => {
    mkdirSync(path.join(wt, ".eslintrc"));
    write("package.json", "not json");
    expect(findEslintConfigDir(write("a.js"), wt)).toBeNull();
  });

  test("a file in node_modules or outside the worktree is not the project's", () => {
    write("eslint.config.js");
    expect(findEslintConfigDir(write("node_modules/x/a.js"), wt)).toBeNull();
    expect(findEslintConfigDir("/elsewhere/a.js", wt)).toBeNull();
  });

  test("a repository nested in the worktree is not the project's", () => {
    write("eslint.config.js");
    write("vendor/other/eslint.config.js");
    write("vendor/other/node_modules/eslint/package.json", "{}");
    mkdirSync(path.join(wt, "vendor/other/.git"));
    const file = write("vendor/other/a.js");
    expect(findEslintConfigDir(file, wt)).toBeNull();
    expect(hasInstalledEslint(file, wt)).toBe(false);
  });
});

describe("hasInstalledEslint", () => {
  test("looks from the file up to the worktree", () => {
    const file = write("packages/app/src/a.js");
    expect(hasInstalledEslint(file, wt)).toBe(false);
    write("node_modules/eslint/package.json", "{}");
    expect(hasInstalledEslint(file, wt)).toBe(true);
  });
});

describe("eslintNotInstalledMessage", () => {
  test.each([
    ["pnpm-lock.yaml", "pnpm install"],
    ["yarn.lock", "yarn install"],
    ["bun.lock", "bun install"],
    ["package-lock.json", "npm install"],
  ])("a project naming ESLint with %s runs its install", (lockfile, command) => {
    write(lockfile);
    write("package.json", JSON.stringify({ devDependencies: { eslint: "^9" } }));
    expect(eslintNotInstalledMessage(wt, wt)).toContain(`\`${command}\``);
  });

  test("a project not naming ESLint adds it", () => {
    write("package.json", "{}");
    expect(eslintNotInstalledMessage(wt, wt)).toContain("`npm install --save-dev eslint`");
    write("pnpm-lock.yaml");
    expect(eslintNotInstalledMessage(wt, wt)).toContain("`pnpm add -D eslint`");
  });
});
