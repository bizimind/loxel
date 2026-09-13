import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { runGit } from "./run.ts";
import { worktreeChanges } from "./worktree.ts";

describe("runGit", () => {
  test("returns a failed result when the working directory no longer exists", async () => {
    const missing = join(process.cwd(), ".missing-wt-run-git-directory", crypto.randomUUID());

    const result = await runGit(["status", "--porcelain"], missing);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(missing);
    expect(await worktreeChanges(missing)).toEqual([]);
  });
});
