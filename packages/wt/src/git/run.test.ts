import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createTestDirectory, createTestRepo } from "../test-repo.ts";
import { git, runGit } from "./run.ts";
import { worktreeChanges } from "./worktree.ts";

describe("runGit", () => {
  test("returns a failed result when the working directory no longer exists", async () => {
    const directory = await createTestDirectory();
    const missing = join(directory.root, "missing");

    try {
      const result = await runGit(["status", "--porcelain"], missing);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(missing);
      expect(await worktreeChanges(missing)).toEqual([]);
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
});
