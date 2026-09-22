import { afterEach, describe, expect, test } from "bun:test";

import { createTestRepo, enableOriginTracking, type TestRepo } from "../test-repo.ts";
import { getCurrentBranch, resolveRemoteDefault } from "./branch.ts";
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

describe("resolveRemoteDefault", () => {
  test("returns null for a repo without a remote", async () => {
    repo = await createTestRepo();
    expect(await resolveRemoteDefault(repo.root)).toBeNull();
  });

  test("returns null for a bare clone with no tracking refs", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await resolveRemoteDefault(repo.root)).toBeNull();
  });

  test("reads origin/HEAD when recorded", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    expect(await resolveRemoteDefault(repo.root)).toBe("origin/main");
  });

  test("falls back to origin/main by existence when origin/HEAD is unset", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["remote", "set-head", "origin", "-d"], repo.root);
    expect(await resolveRemoteDefault(repo.root)).toBe("origin/main");
  });
});
