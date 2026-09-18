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
      // `fork` sorts before `origin` in for-each-ref output, so this only
      // passes if origin is chosen deliberately rather than by list order.
      await $`git -C ${repo.path} update-ref refs/remotes/fork/trunk HEAD`.quiet();
      await $`git -C ${repo.path} symbolic-ref refs/remotes/fork/HEAD refs/remotes/fork/trunk`.quiet();
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
      // `main` still exists; the configured name must win over it.
      await $`git -C ${repo.path} branch trunk`.quiet();
      await $`git -C ${repo.path} config init.defaultBranch trunk`.quiet();

      expect(await resolveDefaultBranchRef(repo.path)).toBe("trunk");
    } finally {
      await repo.cleanup();
    }
  });

  test("resolves a bare repository's HEAD from one of its linked worktrees", async () => {
    const repo = await createBareRepo();
    const worktree = `${repo.path}-wt`;
    try {
      await $`git -C ${repo.path} symbolic-ref HEAD refs/heads/develop`.quiet();
      await $`git -C ${repo.path} worktree add --orphan -b develop ${worktree}`.quiet();
      await $`git -C ${worktree} config user.email "test@loxel.dev"`.quiet();
      await $`git -C ${worktree} config user.name "Test"`.quiet();
      await commit(worktree, "A", { "a.txt": "a" });
      await $`git -C ${worktree} checkout -q -b topic`.quiet();

      // From the worktree, --is-bare-repository is false; core.bare still says true.
      expect(await resolveDefaultBranchRef(worktree)).toBe("develop");
    } finally {
      await $`git -C ${repo.path} worktree remove --force ${worktree}`.quiet().nothrow();
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
    const worktree = `${repo.path}-wt`;
    try {
      // A bare repo's HEAD is the default branch, unlike a worktree's.
      await $`git -C ${repo.path} symbolic-ref HEAD refs/heads/trunk`.quiet();
      await $`git -C ${repo.path} worktree add --orphan -b trunk ${worktree}`.quiet();
      await $`git -C ${worktree} config user.email "test@loxel.dev"`.quiet();
      await $`git -C ${worktree} config user.name "Test"`.quiet();
      await commit(worktree, "A", { "a.txt": "a" });
      expect(await resolveDefaultBranchRef(repo.path)).toBe("trunk");
    } finally {
      await $`git -C ${repo.path} worktree remove --force ${worktree}`.quiet().nothrow();
      await repo.cleanup();
    }
  });

  test("skips a bare repository's dangling HEAD and falls through to main", async () => {
    // `git init --bare` leaves HEAD -> master; pushing main never moves it.
    const repo = await createBareRepo();
    const worktree = `${repo.path}-wt`;
    try {
      await $`git -C ${repo.path} symbolic-ref HEAD refs/heads/master`.quiet();
      await $`git -C ${repo.path} worktree add --orphan -b main ${worktree}`.quiet();
      await $`git -C ${worktree} config user.email "test@loxel.dev"`.quiet();
      await $`git -C ${worktree} config user.name "Test"`.quiet();
      await commit(worktree, "A", { "a.txt": "a" });
      await $`git -C ${worktree} checkout -q -b topic`.quiet();

      expect(await resolveDefaultBranchRef(worktree)).toBe("main");
      expect(await resolveDefaultBranchRef(repo.path)).toBe("main");
    } finally {
      await $`git -C ${repo.path} worktree remove --force ${worktree}`.quiet().nothrow();
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
