import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { $ } from "bun";

import { getRepoTrustStatus, setRepoTrusted } from "../repo-trust";
import { getCommitDiff, getUnstagedDiff, getWorkingTreeDiff } from "./diff";
import { getFileContent } from "./file-content";
import { readOnlyGitEnv, worktreeReadEnv } from "./git-env";
import { ContentAwaitsTrustError, runGit } from "./run-git";
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
    expect(readOnlyGitEnv()).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_CONFIG_PARAMETERS: OFF,
    });
  });

  test("leaves them to the user's Git configuration only in a trusted repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-env-"));
    try {
      expect(readOnlyGitEnv(dir).GIT_CONFIG_PARAMETERS).toBe(OFF);
      setRepoTrusted(dir, true);
      expect(readOnlyGitEnv(dir).GIT_OPTIONAL_LOCKS).toBe("0");
      expect(readOnlyGitEnv(dir).GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(readOnlyGitEnv(dir).GIT_NO_LAZY_FETCH).toBeUndefined();
      expect(readOnlyGitEnv(dir).GIT_ALLOW_PROTOCOL).toBeUndefined();
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

describe("a partial clone in an untrusted repository", () => {
  /** A clone without file contents of a repository with two commits, and those commits. */
  async function partialClone() {
    const origin = await createRepo();
    const first = await commit(origin.path, "first", { "a.txt": "a\n" });
    const second = await commit(origin.path, "second", { "a.txt": "b\n" });
    await $`git -C ${origin.path} config uploadpack.allowFilter true`.quiet();
    const clone = `${origin.path}-clone`;
    await $`git clone --quiet --filter=blob:none file://${origin.path} ${clone}`.quiet();
    const cleanup = async () => {
      await rm(clone, { recursive: true, force: true });
      await origin.cleanup();
    };
    return { clone, first, second, cleanup };
  }

  test("content the clone doesn't have yet waits for trust", async () => {
    const { clone, first, second, cleanup } = await partialClone();
    try {
      // The first commit's `a.txt` was never downloaded.
      const error = await getCommitDiff(clone, second).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ContentAwaitsTrustError);
      expect(getRepoTrustStatus(clone).restrictions).toHaveLength(1);
      // A path the commit doesn't have, or a commit the repository doesn't have, is no such content.
      expect(await getFileContent(clone, "missing.txt", second)).toEqual([]);
      expect(await getCommitDiff(clone, "0".repeat(40))).toMatchObject({ files: [] });

      // A git too old for GIT_NO_LAZY_FETCH ignores it; the transport setting still refuses.
      const { GIT_NO_LAZY_FETCH: _ignored, ...olderGitEnv } = readOnlyGitEnv(clone);
      const olderGit = await runGit(["diff-tree", "-p", second], { cwd: clone, env: olderGitEnv })
        .then(() => null)
        .catch((err: unknown) => err);
      expect(olderGit).toBeInstanceOf(ContentAwaitsTrustError);

      setRepoTrusted(clone, true);
      expect(await getFileContent(clone, "a.txt", first)).toEqual(["a", ""]);
      const diff = await getCommitDiff(clone, second);
      expect(diff.files.map((f) => [f.newPath, f.additions, f.deletions])).toEqual([
        ["a.txt", 1, 1],
      ]);
    } finally {
      await cleanup();
    }
  });
});
