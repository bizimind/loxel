import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoFilterDrivers } from "./repo-filter-drivers";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("reads every way a config names a filter, and stops at include loops", () => {
  root = mkdtempSync(join(tmpdir(), "repo-filter-drivers-"));
  const gitDir = join(root, ".git");
  mkdirSync(gitDir);
  writeFileSync(
    join(root, "more"),
    `[FILTER "Mixed"]\n[filter.Legacy]\n[include]\n\tpath = more\n`,
  );
  writeFileSync(
    join(gitDir, "config"),
    [
      `[core] [filter "same-line"]`,
      `[filter "esc\\"aped"]`,
      `[filter.Sub "Name"]`,
      `[FILTER.A.b "C"]`,
      `[filter..e "f"]`,
      `[filter.g..h "i"]`,
      `[filter.j. "k"]`,
      `[filter. "l"]`,
      `[filter.]`,
      `[filter]`,
      `[include] path = ../more ; a comment`,
      `[include]`,
      `\tpath = config`,
    ].join("\n"),
  );
  expect(repoFilterDrivers(root)?.toSorted()).toEqual(
    [
      "",
      ".e.f",
      ".l",
      "Mixed",
      "a.b.C",
      'esc"aped',
      "g..h.i",
      "j..k",
      "legacy",
      "same-line",
      "sub.Name",
    ].toSorted(),
  );
});

test("does not know the drivers when a config file is too large to read", () => {
  root = mkdtempSync(join(tmpdir(), "repo-filter-drivers-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), `[include] path = ../big\n`);
  writeFileSync(join(root, "big"), "");
  truncateSync(join(root, "big"), 9 * 1024 * 1024);
  expect(repoFilterDrivers(root)).toBeNull();
});

/** A temporary folder, removed after the test. */
function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "repo-filter-drivers-"));
  return root;
}

test("reads names and include paths as git does, as bytes", () => {
  const dir = makeRoot();
  mkdirSync(join(dir, ".git"));
  const config = join(dir, ".git", "config");
  // A name an environment variable cannot carry cannot be turned off.
  writeFileSync(config, Buffer.concat([Buffer.from('[filter "'), Buffer.from([0xff, 0x22, 0x5d])]));
  expect(repoFilterDrivers(dir)).toBeNull();

  // An include path that is not UTF-8, naming a file that defines an ordinary driver, where the
  // filesystem allows such a name (APFS does not).
  const oddFile = Buffer.concat([Buffer.from(join(dir, "inc")), Buffer.from([0xff])]);
  try {
    writeFileSync(oddFile, `[filter "plain"]\n`);
  } catch {
    return;
  }
  writeFileSync(
    config,
    Buffer.concat([Buffer.from("[include]\n\tpath = ../inc"), Buffer.from([0xff, 0x0a])]),
  );
  expect(repoFilterDrivers(dir)).toEqual(["plain"]);
});

test("finds the config through a symlinked .git and a linked worktree's commondir", () => {
  const dir = makeRoot();
  const main = join(dir, "main.git");
  mkdirSync(join(main, "worktrees", "wt"), { recursive: true });
  writeFileSync(join(main, "config"), `[filter "shared"]\n`);
  const linked = join(dir, "linked");
  mkdirSync(linked);
  symlinkSync(main, join(linked, ".git"));
  expect(repoFilterDrivers(linked)).toEqual(["shared"]);

  const wt = join(dir, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, "worktrees", "wt")}\n`);
  writeFileSync(join(main, "worktrees", "wt", "commondir"), "../..\n");
  expect(repoFilterDrivers(wt)).toEqual(["shared"]);
  // Past what the scan reads, where it says to look is unknown.
  truncateSync(join(main, "worktrees", "wt", "commondir"), 9 * 1024 * 1024);
  expect(repoFilterDrivers(wt)).toBeNull();
});

test("stops at its budget however the includes multiply", () => {
  const dir = makeRoot();
  mkdirSync(join(dir, ".git"));
  const includes = Array.from({ length: 300 }, (_, i) => `[include] path = ../inc-${i}`);
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, `inc-${i}`), "");
  writeFileSync(join(dir, ".git", "config"), includes.join("\n"));
  expect(repoFilterDrivers(dir)).toBeNull();
});

test("keeps a name's leading byte-order mark, as git does", () => {
  const dir = makeRoot();
  mkdirSync(join(dir, ".git"));
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(
    join(dir, ".git", "config"),
    Buffer.concat([Buffer.from('[filter "'), bom, Buffer.from('a"]\n\tclean = x\n')]),
  );
  expect(repoFilterDrivers(dir)).toEqual(["\uFEFFa"]);
});

test("follows only include paths, the way git parses sections", () => {
  const dir = makeRoot();
  mkdirSync(join(dir, ".git"));
  // A program's path is not config: reading it would only cost the budget.
  writeFileSync(join(dir, "tool"), "");
  truncateSync(join(dir, "tool"), 9 * 1024 * 1024);
  writeFileSync(join(dir, "inc"), `[filter "followed"]\n\tclean = x\n`);
  writeFileSync(
    join(dir, ".git", "config"),
    [
      `[difftool "ext"]`,
      `\tpath = ../tool`,
      // Brackets in a value open no section, so this path is still an include.
      `[include]`,
      `\tdecoy = [core]`,
      `\tpath = ../inc`,
    ].join("\n"),
  );
  expect(repoFilterDrivers(dir)).toEqual(["followed"]);
});

test("counts include paths that name nothing against its budget", () => {
  const dir = makeRoot();
  mkdirSync(join(dir, ".git"));
  const includes = Array.from({ length: 300 }, (_, i) => `[include] path = ../missing-${i}`);
  writeFileSync(join(dir, ".git", "config"), includes.join("\n"));
  expect(repoFilterDrivers(dir)).toBeNull();
});
