import { describe, expect, test } from "bun:test";

import { $ } from "bun";

import { resolveDefaultBranchRef } from "./repo";
import { commit, createBareRepo, createRepo } from "./test-utils";

/**
 * The fallback chain matters because each step covers a repository shape the
 * previous one misses, and getting it wrong silently changes which commits a
 * branch appears to contain.
 */
describe("resolveDefaultBranchRef", () => {
  test("prefers origin/HEAD, even when it points at an unconventional name", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} update-ref refs/remotes/origin/develop HEAD`.quiet();
      await $`git -C ${repo.path} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("origin/develop");
    } finally {
      await repo.cleanup();
    }
  });

  test("uses another remote's HEAD when origin has none", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} update-ref refs/remotes/upstream/trunk HEAD`.quiet();
      await $`git -C ${repo.path} symbolic-ref refs/remotes/upstream/HEAD refs/remotes/upstream/trunk`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("upstream/trunk");
    } finally {
      await repo.cleanup();
    }
  });

  test("prefers origin's HEAD over another remote's", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} update-ref refs/remotes/upstream/trunk HEAD`.quiet();
      await $`git -C ${repo.path} symbolic-ref refs/remotes/upstream/HEAD refs/remotes/upstream/trunk`.quiet();
      await $`git -C ${repo.path} update-ref refs/remotes/origin/main HEAD`.quiet();
      await $`git -C ${repo.path} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("origin/main");
    } finally {
      await repo.cleanup();
    }
  });

  test("honours a local init.defaultBranch before the conventional names", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} branch -m main trunk`.quiet();
      await $`git -C ${repo.path} config init.defaultBranch trunk`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("trunk");
    } finally {
      await repo.cleanup();
    }
  });

  test("falls back to origin/main when origin/HEAD is missing", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} update-ref refs/remotes/origin/main HEAD`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("origin/main");
    } finally {
      await repo.cleanup();
    }
  });

  test("falls back to origin/master", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} update-ref refs/remotes/origin/master HEAD`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("origin/master");
    } finally {
      await repo.cleanup();
    }
  });

  test("uses a bare repository's own HEAD", async () => {
    const repo = await createBareRepo();
    try {
      // A bare repo's HEAD is the default branch, unlike a worktree's.
      await $`git -C ${repo.path} symbolic-ref HEAD refs/heads/trunk`.quiet();
      expect(await resolveDefaultBranchRef(repo.path)).toBe("trunk");
    } finally {
      await repo.cleanup();
    }
  });

  test("does not use a worktree's HEAD as the default", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} checkout -b topic`.quiet();

      // `main` exists, so it wins; the checked-out branch must never be
      // mistaken for the default or every branch becomes its own base.
      expect(await resolveDefaultBranchRef(repo.path)).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns null when nothing recognizable exists", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "A", { "a.txt": "a" });
      await $`git -C ${repo.path} branch -m main odd-default`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});
