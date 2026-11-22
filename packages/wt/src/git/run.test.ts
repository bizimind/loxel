import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createTestDirectory, createTestRepo } from "../test-repo.ts";
import { git, runGit, withGitEnv } from "./run.ts";
import { addWorktree, isWorktreeDirty, worktreeStatus } from "./worktree.ts";

describe("runGit", () => {
  test("returns a failed result when the working directory no longer exists", async () => {
    const directory = await createTestDirectory();
    const missing = join(directory.root, "missing");

    try {
      const result = await runGit(["status", "--porcelain"], missing);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(missing);
      expect(await isWorktreeDirty(missing)).toBe(false);
    } finally {
      await directory.cleanup();
    }
  });

  test("uses a stable locale while preserving the surrounding environment", async () => {
    const repo = await createTestRepo();
    process.env.WT_RUN_TEST_MARKER = "preserved";
    try {
      await git(
        [
          "config",
          "alias.print-run-env",
          '!printf \'%s|%s|%s\' "$LC_ALL" "$LANG" "$WT_RUN_TEST_MARKER"',
        ],
        repo.root,
      );

      expect(await git(["print-run-env"], repo.root)).toBe("C|C|preserved");
    } finally {
      delete process.env.WT_RUN_TEST_MARKER;
      await repo.cleanup();
    }
  });

  test("adds a scoped environment to every git command inside withGitEnv, and only there", async () => {
    const repo = await createTestRepo();
    try {
      await git(
        ["config", "alias.print-scoped-env", "!printf '%s' \"$WT_SCOPED_MARKER\""],
        repo.root,
      );

      const inside = await withGitEnv({ WT_SCOPED_MARKER: "scoped" }, async () => {
        await Promise.resolve();
        return git(["print-scoped-env"], repo.root);
      });

      expect(inside).toBe("scoped");
      expect(await git(["print-scoped-env"], repo.root)).toBe("");

      // Concurrent scopes keep their own values; a nested one adds to its outer scope.
      const both = await Promise.all(
        ["a", "b"].map((value) =>
          withGitEnv({ WT_SCOPED_MARKER: value }, () => git(["print-scoped-env"], repo.root)),
        ),
      );
      expect(both).toEqual(["a", "b"]);
      await git(
        ["config", "alias.print-both", '!printf \'%s|%s\' "$WT_SCOPED_MARKER" "$WT_OTHER"'],
        repo.root,
      );
      const nested = await withGitEnv({ WT_SCOPED_MARKER: "outer", WT_OTHER: "kept" }, () =>
        withGitEnv({ WT_SCOPED_MARKER: "inner" }, () => git(["print-both"], repo.root)),
      );
      expect(nested).toBe("inner|kept");
    } finally {
      await repo.cleanup();
    }
  });

  test("fills in a new checkout under the env checkoutEnv gives for it", async () => {
    const repo = await createTestRepo();
    try {
      const path = join(repo.root, "..", "staged");
      const asked: string[] = [];
      await withGitEnv(
        {},
        () => addWorktree(repo.root, path, { newBranch: "staged" }),
        async (worktreePath) => {
          asked.push(worktreePath);
          return { GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false'" };
        },
      );

      expect(asked).toEqual([path]);
      expect(await worktreeStatus(path)).toEqual({ ok: true, value: [] });
      expect(await git(["ls-files"], path)).toBe(await git(["ls-files"], repo.root));
    } finally {
      await repo.cleanup();
    }
  });
});
