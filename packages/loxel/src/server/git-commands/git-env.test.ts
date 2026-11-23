import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { hasUncommittedChanges, withGitEnv } from "@bizimind/wt/lib";
import { $ } from "bun";

import { setRepoTrusted } from "../repo-trust";
import { getUnstagedDiff, getWorkingTreeDiff } from "./diff";
import { readOnlyGitEnv, untrustedChangeGitEnv, worktreeReadEnv } from "./git-env";
import { getStatus } from "./status";
import { commit, createRepo, writeFile } from "./test-utils";

const OFF = "'core.fsmonitor=false' 'log.showSignature=false'";
const saved = { params: process.env.GIT_CONFIG_PARAMETERS, global: process.env.GIT_CONFIG_GLOBAL };

beforeEach(() => {
  delete process.env.GIT_CONFIG_PARAMETERS;
});

afterEach(() => {
  for (const [key, value] of [
    ["GIT_CONFIG_PARAMETERS", saved.params],
    ["GIT_CONFIG_GLOBAL", saved.global],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("readOnlyGitEnv", () => {
  test("turns fsmonitor and signature checks off", () => {
    expect(readOnlyGitEnv()).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_PARAMETERS: OFF });
  });

  test("leaves them to the user's Git configuration only in a trusted repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-env-"));
    try {
      expect(readOnlyGitEnv(dir).GIT_CONFIG_PARAMETERS).toBe(OFF);
      setRepoTrusted(dir, true);
      expect(readOnlyGitEnv(dir).GIT_OPTIONAL_LOCKS).toBe("0");
      expect(readOnlyGitEnv(dir).GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(readOnlyGitEnv().GIT_CONFIG_PARAMETERS).toBe(OFF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps config parameters already in the environment", () => {
    process.env.GIT_CONFIG_PARAMETERS = "'user.name=someone'";
    expect(readOnlyGitEnv().GIT_CONFIG_PARAMETERS).toBe(`'user.name=someone' ${OFF}`);
  });
});

describe("working-tree reads in an untrusted repository", () => {
  /**
   * A repository whose own config names a filter driver (through an include) and a diff driver for
   * `a.txt`, each a program that records that it ran. `a.txt` is committed, then given a new mtime
   * at the same size, so git has to hash it again to compare it with the index.
   */
  async function repoWithPrograms() {
    const repo = await createRepo();
    const ran = `${repo.path}-ran`;
    // Appends its first argument to `ran`, then passes the content through.
    const record = `${repo.path}-record`;
    await Bun.write(record, `#!/bin/sh\necho "$1" >> "${ran}"\nshift\nexec cat "$@"\n`);
    await chmod(record, 0o755);
    await commit(repo.path, "init", {
      ".gitattributes": "a.txt filter=f diff=d\n",
      "a.txt": "a\n",
    });
    await $`git -C ${repo.path} config include.path extra`.quiet();
    await Bun.write(
      path.join(repo.path, ".git/extra"),
      `[filter "f"]\n\tclean = ${record} filter\n\tsmudge = cat\n\trequired = true\n`,
    );
    await $`git -C ${repo.path} config diff.d.textconv ${`${record} textconv`}`.quiet();
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(path.join(repo.path, "a.txt"), past, past);
    const programsRan = async () => {
      const file = Bun.file(ran);
      return (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : [];
    };
    const cleanup = async () => {
      await rm(ran, { force: true });
      await rm(record, { force: true });
      await repo.cleanup();
    };
    return { repo, programsRan, cleanup };
  }

  test("status and diffs run none of the repository's programs", async () => {
    const { repo, programsRan, cleanup } = await repoWithPrograms();
    try {
      const status = await getStatus(repo.path);
      expect(status.unstaged).toEqual([]);

      await writeFile(repo.path, "a.txt", "b\n");
      const unstaged = await getUnstagedDiff(repo.path);
      expect(unstaged.files.map((f) => f.newPath)).toEqual(["a.txt"]);
      await writeFile(repo.path, "new.txt", "new\n");
      const working = await getWorkingTreeDiff(repo.path, repo.path);
      expect(working.files.map((f) => f.newPath).toSorted()).toEqual(["a.txt", "new.txt"]);

      expect(await programsRan()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("they run once the repository is trusted", async () => {
    const { repo, programsRan, cleanup } = await repoWithPrograms();
    try {
      setRepoTrusted(repo.path, true);
      await getStatus(repo.path);
      await writeFile(repo.path, "a.txt", "b\n");
      await getUnstagedDiff(repo.path);
      expect(new Set(await programsRan())).toEqual(new Set(["filter", "textconv"]));
    } finally {
      await cleanup();
    }
  });

  test("git's own trace output on stderr does not fail them", async () => {
    const repo = await createRepo();
    const savedTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = "1";
    try {
      await commit(repo.path, "init", { "a.txt": "a\n" });
      await writeFile(repo.path, "a.txt", "b\n");
      expect((await getStatus(repo.path)).unstaged.map((file) => file.path)).toEqual(["a.txt"]);
      expect((await getUnstagedDiff(repo.path)).files.map((f) => f.newPath)).toEqual(["a.txt"]);
    } finally {
      if (savedTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = savedTrace;
      await repo.cleanup();
    }
  });

  test("the user's own global filter drivers keep their commands", async () => {
    const { repo, cleanup } = await repoWithPrograms();
    const global = `${repo.path}-global`;
    try {
      await Bun.write(global, `[filter "lfs"]\n\tclean = git-lfs clean -- %f\n`);
      process.env.GIT_CONFIG_GLOBAL = global;
      const params = (await worktreeReadEnv(repo.path)).GIT_CONFIG_PARAMETERS;
      expect(params).toContain("'filter.f.clean='");
      expect(params).not.toContain("filter.lfs");
    } finally {
      await rm(global, { force: true });
      await cleanup();
    }
  });
});

describe("untrustedChangeGitEnv", () => {
  test("turns off hooks, fsmonitor and the filter drivers of the repository and its submodules", async () => {
    const sub = await createRepo();
    const repo = await createRepo();
    const ran = `${repo.path}-ran`;
    try {
      await commit(sub.path, "init", { ".gitattributes": "b.txt filter=g\n", "b.txt": "b\n" });
      await commit(repo.path, "init", { ".gitattributes": "a.txt filter=f\n", "a.txt": "a\n" });
      await $`git -C ${repo.path} -c protocol.file.allow=always submodule add -q ${sub.path} sub`.quiet();
      await $`git -C ${repo.path} -c user.email=t@example.com -c user.name=T commit -qm sub`.quiet();
      const recordRun = `sh -c 'echo ran >> "${ran}"; cat'`;
      await $`git -C ${repo.path} config filter.f.clean ${recordRun}`.quiet();
      await $`git -C ${join(repo.path, "sub")} config filter.g.clean ${recordRun}`.quiet();
      // Same size, new mtime: git has to hash the file again, through its filter.
      const past = new Date("2020-01-01T00:00:00Z");
      await writeFile(join(repo.path, "sub"), "b.txt", "c\n");
      await utimes(join(repo.path, "sub", "b.txt"), past, past);

      const env = await untrustedChangeGitEnv(repo.path);
      for (const entry of [
        "core.hooksPath=/dev/null",
        "core.fsmonitor=false",
        "filter.f.clean=",
        "filter.g.clean=",
      ]) {
        expect(env.GIT_CONFIG_PARAMETERS).toContain(`'${entry}'`);
      }
      // Still strict about an edit inside a submodule.
      expect(await withGitEnv(env, () => hasUncommittedChanges(repo.path))).toBe(true);
      expect(await Bun.file(ran).exists()).toBe(false);
      // Without it, the same check runs the submodule's filter.
      await hasUncommittedChanges(repo.path);
      expect(await Bun.file(ran).exists()).toBe(true);
    } finally {
      await rm(ran, { force: true });
      await repo.cleanup();
      await sub.cleanup();
    }
  });
});
