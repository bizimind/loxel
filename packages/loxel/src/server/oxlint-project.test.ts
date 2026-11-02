import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      "a uses oxlint, but oxlint isn't installed. Run `pnpm add -D oxlint` in that folder.",
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

  test("skips what a .gitignore covers and node_modules", async () => {
    git("init", "-q");
    write(".gitignore", "ignored/\n");
    write("ignored/clone/.git/HEAD");
    write("ignored/clone/.oxlintrc.json");
    write("node_modules/dep/.git/HEAD");
    write("node_modules/dep/.oxlintrc.json");
    write(".oxlintrc.json");
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([]);
  });

  test.each([
    ["a .gitignore in another case", () => write(".gitignore", "Vendor/\n")],
    ["only the repository's own excludes", () => write(".git/info/exclude", "vendor/\n")],
  ])("does not skip for %s, which the server does not follow", async (_what, ignore) => {
    git("init", "-q");
    ignore();
    write("vendor/clone/.git/HEAD");
    write("vendor/clone/.oxlintrc.json");
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([path.join(wt, "vendor/clone")]);
  });

  test("does not skip for a .gitignore above a worktree that is a repository's subfolder", async () => {
    const { exitCode } = Bun.spawnSync(["git", "-C", top, "init", "-q"]);
    expect(exitCode).toBe(0);
    writeFileSync(path.join(top, ".gitignore"), "vendor/\n");
    write("vendor/clone/.git/HEAD");
    write("vendor/clone/.oxlintrc.json");
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([path.join(wt, "vendor/clone")]);
  });

  test("follows a link out of the worktree, whose target stands for itself", async () => {
    mkdirSync(path.join(top, "elsewhere"));
    writeFileSync(path.join(top, "elsewhere/.oxlintrc.json"), "");
    write("x.js");
    symlinkSync(path.join(top, "elsewhere"), path.join(wt, "link"));
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([path.join(top, "elsewhere")]);
  });

  test("a link into a nested repository counts, and a link inside the project does not", async () => {
    git("init", "-q");
    write(".gitignore", "hidden/\n");
    write("hidden/clone/.git/HEAD");
    write("hidden/clone/.oxlintrc.json");
    write("packages/a/.oxlintrc.json");
    symlinkSync(path.join(wt, "packages/a"), path.join(wt, "alias"));
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([]);
    symlinkSync(path.join(wt, "hidden/clone"), path.join(wt, "link"));
    expect((await scanWorktree(wt)).nestedConfigRepos).toEqual([path.join(wt, "link")]);
  });

  test("a link to a parent ends", async () => {
    write("a/x.js");
    symlinkSync(wt, path.join(wt, "a/up"));
    expect((await scanWorktree(wt)).incomplete).toBe(false);
  });

  test("an aborted walk stops", async () => {
    write("a/.git/HEAD");
    write("a/.oxlintrc.json");
    const { nestedConfigRepos } = await scanWorktree(wt, { signal: AbortSignal.abort() });
    expect(nestedConfigRepos).toEqual([]);
  });

  test("a folder it cannot read leaves the answer incomplete", async () => {
    write("locked/x.js");
    chmodSync(path.join(wt, "locked"), 0o000);
    try {
      expect((await scanWorktree(wt)).incomplete).toBe(true);
    } finally {
      chmodSync(path.join(wt, "locked"), 0o755);
    }
  });

  test("a walk over its limit says so", async () => {
    write("a/b/c/d/x.js");
    expect((await scanWorktree(wt, { maxDirs: 2 })).incomplete).toBe(true);
    expect((await scanWorktree(wt)).incomplete).toBe(false);
  });

  test("with no config at the root, a config above it counts, under the repository holding it", async () => {
    mkdirSync(path.join(top, ".git"));
    writeFileSync(path.join(top, ".oxlintrc.json"), "");
    expect((await scanWorktree(wt)).ancestorRepos).toEqual([top]);
    write(".oxlintrc.json");
    expect((await scanWorktree(wt)).ancestorRepos).toEqual([]);
  });

  test("a directory named like a config at the root does not stop the look upward", async () => {
    writeFileSync(path.join(top, ".oxlintrc.json"), "");
    mkdirSync(path.join(wt, ".oxlintrc.json"));
    expect((await scanWorktree(wt)).ancestorRepos).toEqual([top]);
  });

  test("with no type checker at the root, one above it counts", async () => {
    write(".oxlintrc.json");
    mkdirSync(path.join(top, "node_modules/.bin"), { recursive: true });
    writeFileSync(path.join(top, "node_modules/.bin/tsgolint"), "");
    expect((await scanWorktree(wt)).ancestorRepos).toEqual([top]);
    write("node_modules/.bin/tsgolint");
    expect((await scanWorktree(wt)).ancestorRepos).toEqual([]);
  });

  test("what lies above with no repository around it stands for itself", async () => {
    const nested = path.join(wt, "deep");
    mkdirSync(nested);
    write(".oxlintrc.json");
    expect((await scanWorktree(nested)).ancestorRepos).toEqual([wt]);
  });
});
