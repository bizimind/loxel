import { afterEach, describe, expect, test } from "bun:test";

import { createTestRepo, type TestRepo } from "../test-repo.ts";
import { getCurrentBranch } from "./branch.ts";
import { git } from "./run.ts";

let repo: TestRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

describe("getCurrentBranch", () => {
  test("returns the checked-out branch", async () => {
    repo = await createTestRepo();
    expect(await getCurrentBranch(repo.root)).toBe("main");
  });

  test("rejects a detached HEAD", async () => {
    repo = await createTestRepo();
    await git(["checkout", "--detach"], repo.root);
    await expect(getCurrentBranch(repo.root)).rejects.toThrow("detached HEAD");
  });
});
