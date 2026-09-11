import { afterEach, describe, expect, test } from "bun:test";

import { createTestRepo, type TestRepo } from "../test-repo.ts";
import { git } from "./run.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

describe("runGit", () => {
  test("uses a stable locale while preserving the surrounding environment", async () => {
    repo = await createTestRepo();
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
    }
  });
});
