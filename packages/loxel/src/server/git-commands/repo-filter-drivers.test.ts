import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      `[filter "contin\\`,
      `ued"]`,
      `[include] path = ../more ; a comment`,
      `[include]`,
      `\tpath = config`,
    ].join("\n"),
  );
  expect(repoFilterDrivers(root).toSorted()).toEqual(
    ["Mixed", "continued", 'esc"aped', "legacy", "same-line"].toSorted(),
  );
});
