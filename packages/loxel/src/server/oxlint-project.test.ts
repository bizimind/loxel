import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findOxlintProjectDir,
  isOxlintConfigFile,
  isOxlintFile,
  oxlintNotInstalledMessage,
  scanWorktree,
} from "./oxlint-project";

let top: string;
let wt: string;

function write(rel: string, text = ""): string {
  const file = path.join(wt, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function git(...args: string[]): void {
  const { exitCode, stderr } = Bun.spawnSync(["git", "-C", wt, ...args]);
  if (exitCode !== 0) throw new Error(stderr.toString());
}

beforeEach(() => {
  top = realpathSync(mkdtempSync(path.join(tmpdir(), "oxlint-project-")));
  wt = path.join(top, "wt");
  mkdirSync(wt);
});

afterEach(() => {
  rmSync(top, { recursive: true, force: true });
});

test.each([".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"])(
  "%s is a config, in any folder",
  (name) => {
    expect(isOxlintConfigFile(path.join(wt, "packages/a", name))).toBe(true);
    write(`packages/a/${name}`);
    expect(findOxlintProjectDir(write("packages/a/src/x.js"), wt)).toBe(
      path.join(wt, "packages/a"),
    );
  },
);

describe("which files are oxlint's", () => {
  test("a dependency says so too, a peer dependency does not", () => {
    write("a/package.json", JSON.stringify({ devDependencies: { oxlint: "1" } }));
    write("b/package.json", JSON.stringify({ peerDependencies: { oxlint: "1" } }));
    expect(findOxlintProjectDir(write("a/x.js"), wt)).toBe(path.join(wt, "a"));
    expect(findOxlintProjectDir(write("b/x.js"), wt)).toBeNull();
  });

  test("a file is linted only with an install it resolves", () => {
    write("a/.oxlintrc.json");
    write("b/.oxlintrc.json");
    write("a/node_modules/oxlint/package.json");
    expect(isOxlintFile(write("a/x.js"), wt)).toBe(true);
    expect(isOxlintFile(write("b/x.js"), wt)).toBe(false);
    expect(isOxlintFile(write("c/x.js"), wt)).toBe(false);
  });

  test("a repository nested in the worktree and a dependency are not the project's", () => {
    write(".oxlintrc.json");
    write("node_modules/oxlint/package.json");
    write("nested/.git/HEAD");
    expect(isOxlintFile(write("nested/x.js"), wt)).toBe(false);
    expect(isOxlintFile(write("node_modules/dep/x.js"), wt)).toBe(false);
  });

  test("the missing install is named with the project's package manager", () => {
    write("pnpm-lock.yaml");
    write("a/.oxlintrc.json");
    expect(oxlintNotInstalledMessage(path.join(wt, "a"), wt)).toBe(
      "a has a config, but oxlint isn't installed. Run `pnpm add -D oxlint` in that folder.",
    );
  });
});

describe("scanWorktree", () => {
  test("finds installs nearest first and what says the worktree uses oxlint", async () => {
    write("packages/a/node_modules/oxlint/package.json");
    expect((await scanWorktree(wt)).usesOxlint).toBe(false);
    write("node_modules/oxlint/package.json");
    write("package.json", JSON.stringify({ devDependencies: { oxlint: "1" } }));
    const scan = await scanWorktree(wt);
    expect(scan.usesOxlint).toBe(true);
    expect(scan.installDirs).toEqual([wt, path.join(wt, "packages/a")]);
  });

  test("a project's own nested configs are not a nested repository's", async () => {
    write(".oxlintrc.json");
    write("packages/a/oxlint.config.ts");
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([]);
  });

  test("finds a nested clone's config at any depth, and the nearest repository owns it", async () => {
    write("vendor/clone/.git/HEAD");
    write("vendor/clone/sub/oxlint.config.ts");
    write("vendor/clone/inner/.git/HEAD");
    write("vendor/clone/inner/.oxlintrc.json");
    write("plain/.git/HEAD");
    const { nestedConfigRepos } = await scanWorktree(wt);
    expect(nestedConfigRepos.toSorted()).toEqual([
      path.join(wt, "vendor/clone"),
      path.join(wt, "vendor/clone/inner"),
    ]);
  });

  test("a submodule, whose .git is a file, counts as a nested repository", async () => {
    write("sub/.git", "gitdir: ../.git/modules/sub\n");
    write("sub/.oxlintrc.json");
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([path.join(wt, "sub")]);
  });

  test("skips what git ignores, node_modules and symbolic links", async () => {
    git("init", "-q");
    write(".gitignore", "ignored/\n");
    write("ignored/clone/.git/HEAD");
    write("ignored/clone/.oxlintrc.json");
    write("node_modules/dep/.git/HEAD");
    write("node_modules/dep/.oxlintrc.json");
    mkdirSync(path.join(top, "elsewhere/.git"), { recursive: true });
    writeFileSync(path.join(top, "elsewhere/.oxlintrc.json"), "");
    symlinkSync(path.join(top, "elsewhere"), path.join(wt, "link"));
    write(".oxlintrc.json");
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([]);
  });

  test("a walk over its limit says so", async () => {
    write("a/b/c/d/x.js");
    expect((await scanWorktree(wt, 2)).truncated).toBe(true);
    expect((await scanWorktree(wt)).truncated).toBe(false);
  });

  test("with no config at the root, a config above it counts, under the repository holding it", async () => {
    mkdirSync(path.join(top, ".git"));
    mkdirSync(path.join(top, "conf"));
    writeFileSync(path.join(top, ".oxlintrc.json"), "");
    expect((await scanWorktree(wt)).ancestorConfigRepo).toBe(top);
    write(".oxlintrc.json");
    expect((await scanWorktree(wt)).ancestorConfigRepo).toBeNull();
  });

  test("a config above with no repository around it stands for itself", async () => {
    const nested = path.join(wt, "deep");
    mkdirSync(nested);
    write(".oxlintrc.json");
    expect((await scanWorktree(nested)).ancestorConfigRepo).toBe(wt);
  });
});
