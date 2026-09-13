/**
 * Temporary git repositories for tests.
 *
 * wt has no state of its own — git is the database — so the tests exercise
 * real repositories rather than mocking git.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { git } from "./git/index.ts";

export interface TestRepo {
  /** Repository root: the working tree, or the git dir for a bare repo */
  root: string;
  /** Remove the repository from disk */
  cleanup(): Promise<void>;
}

export type TestDirectory = TestRepo;

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

/** Create a disposable directory that is proven not to overlap this source checkout. */
export async function createTestDirectory(): Promise<TestDirectory> {
  const realTempDir = await realpath(tmpdir());
  const checkoutRoot = await realpath(join(import.meta.dir, "../../.."));
  if (isWithin(realTempDir, checkoutRoot) || isWithin(checkoutRoot, realTempDir)) {
    throw new Error(`Refusing unsafe wt test temp directory: ${realTempDir}`);
  }

  const dir = await realpath(await mkdtemp(join(realTempDir, "wt-test-")));
  return {
    root: dir,
    cleanup: async () => {
      if (dirname(dir) !== realTempDir || !basename(dir).startsWith("wt-test-")) {
        throw new Error(`Refusing to clean unsafe wt test path: ${dir}`);
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a repository with one commit on `main`.
 *
 * @param options.bare - Produce a bare repo (a clone of a seed working tree)
 */
export async function createTestRepo(options: { bare?: boolean } = {}): Promise<TestRepo> {
  const directory = await createTestDirectory();
  const cleanup = () => directory.cleanup();

  try {
    const seed = join(directory.root, "seed");
    await git(["init", "--initial-branch=main", seed]);
    await git(["config", "user.email", "test@example.com"], seed);
    await git(["config", "user.name", "Test"], seed);
    await Bun.write(join(seed, "README.md"), "# seed\n");
    await git(["add", "."], seed);
    await git(["commit", "-m", "initial"], seed);

    if (!options.bare) return { root: seed, cleanup };

    const bare = join(directory.root, "bare.git");
    await git(["clone", "--bare", seed, bare]);
    return { root: bare, cleanup };
  } catch (error) {
    await directory.cleanup();
    throw error;
  }
}

/** Write an executable-by-bash hook script at the repo root. */
export async function writeHook(root: string, hook: string, body: string): Promise<void> {
  await Bun.write(join(root, hook), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
}
