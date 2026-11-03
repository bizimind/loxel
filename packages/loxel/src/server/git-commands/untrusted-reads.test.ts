import { afterEach, describe, expect, test } from "bun:test";
import {
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
  writeFileSync(join(wt, "c.md"), "c\n");
  git(wt, "add", "b.txt", "c.md");
  const mark = (name: string) => `touch '${join(ran, name)}'; cat`;
  writeFileSync(
    join(wt, ".git", "info", "attributes"),
    "* filter=one diff=two\n*.txt filter=three\n*.md filter=we'ird=name\n",
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
  writeFileSync(join(wt, "a.txt"), "a\nb\n");
  writeFileSync(join(wt, "c.md"), "c\nd\n");
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
