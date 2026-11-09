import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setRepoTrusted } from "../repo-trust";
import { getStagedDiff, getUnstagedDiff } from "./diff";
import { getStatus } from "./status";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/**
 * A repository whose own config, one of them through an include, names programs for every file:
 * filter drivers and diff drivers, each leaving a file in `ran/` named after what ran it.
 */
function repoWithDrivers(): { wt: string; ran: () => string[] } {
  root = realpathSync(mkdtempSync(join(tmpdir(), "untrusted-reads-")));
  const wt = join(root, "wt");
  const ran = join(root, "ran");
  mkdirSync(wt);
  mkdirSync(ran);
  git(wt, "init", "-q");
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-q", "-m", "a");
  writeFileSync(join(wt, "b.txt"), "b\n");
  for (const file of ["c.md", "d.cfg", "e.ini"]) writeFileSync(join(wt, file), "c\n");
  git(wt, "add", "b.txt", "c.md", "d.cfg", "e.ini");
  const mark = (name: string) => `touch '${join(ran, name)}'; cat`;
  writeFileSync(
    join(wt, ".git", "info", "attributes"),
    "* filter=one diff=two\n*.txt filter=three\n*.md filter=we'ird=name\n*.cfg filter=four\n*.ini filter=five\n",
  );
  writeFileSync(
    join(root, "included"),
    `[filter "three"]\n\tclean = ${mark("three-clean")}\n\tprocess = ${mark("three-process")}\n`,
  );
  git(wt, "config", "filter.one.clean", mark("one-clean"));
  git(wt, "config", "filter.one.smudge", mark("one-smudge"));
  git(wt, "config", "filter.one.required", "true");
  git(wt, "config", "diff.two.textconv", mark("two-textconv"));
  git(wt, "config", "diff.two.command", mark("two-command"));
  git(wt, "config", "include.path", join(root, "included"));
  // A name git's older `-c` form would split at its `=`.
  git(wt, "config", "filter.we'ird=name.clean", mark("odd-clean"));
  // Headers and includes git reads where a line-by-line reader would not.
  writeFileSync(join(root, "five"), `[filter "five"]\n\tclean = ${mark("five-clean")}\n`);
  appendFileSync(
    join(wt, ".git", "config"),
    `[core] [filter "four"]\n\tclean = ${mark("four-clean")}\n` +
      `[include] path = ${join(root, "five")}\n`,
  );
  // A read that refreshes the index runs this hook.
  writeFileSync(join(wt, ".git", "hooks", "post-index-change"), `#!/bin/sh\n${mark("hook")}\n`);
  chmodSync(join(wt, ".git", "hooks", "post-index-change"), 0o755);
  writeFileSync(join(wt, "a.txt"), "a\nb\n");
  for (const file of ["c.md", "d.cfg", "e.ini"]) writeFileSync(join(wt, file), "c\nd\n");
  return { wt, ran: () => (existsSync(ran) ? readdirSync(ran).toSorted() : []) };
}

describe("git reads in an untrusted repository", () => {
  test("run none of the programs the repository's config names, and do once it is trusted", async () => {
    const { wt, ran } = repoWithDrivers();
    const unstaged = await getUnstagedDiff(wt);
    await getStagedDiff(wt);
    await getStatus(wt);
    expect(ran()).toEqual([]);
    expect(unstaged.files.map((file) => file.newPath)).toContain("a.txt");

    // Trusted, git runs them, and the process filter here, which speaks no protocol, fails the diff.
    setRepoTrusted(wt, true);
    await getUnstagedDiff(wt).catch(() => undefined);
    expect(ran().length).toBeGreaterThan(0);
  });
});
