import { afterEach, describe, expect, test } from "bun:test";

import { createTestRepo, enableOriginTracking, seedPath, type TestRepo } from "../test-repo.ts";
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
    await git(["branch", "develop"], seedPath(repo.root));
    await git(["fetch", "--quiet", "origin"], repo.root);
    await git(["remote", "set-head", "origin", "develop"], repo.root);
    expect(await resolveRemoteDefault(repo.root)).toBe("origin/develop");
  });

  test("ignores a dangling origin/HEAD and falls back by name", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["branch", "develop"], seedPath(repo.root));
    await git(["fetch", "--quiet", "origin"], repo.root);
    await git(["remote", "set-head", "origin", "develop"], repo.root);
    // The remote deletes the branch; a prune drops origin/develop but not the symref.
    await git(["branch", "-D", "develop"], seedPath(repo.root));
    await git(
      ["-c", "remote.origin.followRemoteHEAD=never", "fetch", "--quiet", "--prune", "origin"],
      repo.root,
    );
    expect(await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo.root)).toBe(
      "origin/develop",
    );
    expect(await resolveRemoteDefault(repo.root)).toBe("origin/main");
  });

  test("falls back to origin/master when that is the only conventional ref", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["remote", "set-head", "origin", "-d"], repo.root);
    await git(["update-ref", "refs/remotes/origin/master", "refs/remotes/origin/main"], repo.root);
    await git(["update-ref", "-d", "refs/remotes/origin/main"], repo.root);
    expect(await resolveRemoteDefault(repo.root)).toBe("origin/master");
  });

  test("falls back to origin/main by existence when origin/HEAD is unset", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["remote", "set-head", "origin", "-d"], repo.root);
    expect(await resolveRemoteDefault(repo.root)).toBe("origin/main");
  });
});
