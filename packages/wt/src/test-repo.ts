/**
 * Temporary git repositories for tests.
 *
 * wt has no state of its own — git is the database — so the tests exercise
 * real repositories rather than mocking git.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "./git/index.ts";

export interface TestRepo {
  /** Repository root: the working tree, or the git dir for a bare repo */
  root: string;
  /** Remove the repository from disk */
  cleanup(): Promise<void>;
}

/**
 * Create a repository with one commit on `main`.
 *
 * @param options.bare - Produce a bare repo (a clone of a seed working tree)
 */
export async function createTestRepo(options: { bare?: boolean } = {}): Promise<TestRepo> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "wt-test-")));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  const seed = join(dir, "seed");
  await git(["init", "--initial-branch=main", seed]);
  await git(["config", "user.email", "test@example.com"], seed);
  await git(["config", "user.name", "Test"], seed);
  await Bun.write(join(seed, "README.md"), "# seed\n");
  await git(["add", "."], seed);
  await git(["commit", "-m", "initial"], seed);

  if (!options.bare) return { root: seed, cleanup };

  const bare = join(dir, "bare.git");
  await git(["clone", "--bare", seed, bare]);
  return { root: bare, cleanup };
}

/** Write an executable-by-bash hook script at the repo root. */
export async function writeHook(root: string, hook: string, body: string): Promise<void> {
  await Bun.write(join(root, hook), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
}
