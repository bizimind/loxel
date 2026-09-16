/**
 * Test safety preload for the wt package.
 *
 * wt manages git worktrees and runs shell hooks, so a bad test can delete a
 * real checkout, remove a real branch, or execute an arbitrary hook. This
 * preload creates a programmatic sandbox that prevents tests from interacting
 * with the host repository or inheriting ambient configuration that could
 * redirect git operations.
 *
 * Three layers:
 *
 * 1. GIT_CEILING_DIRECTORIES blocks git from discovering the host repo when a
 *    test runs without an explicit temp-directory path. Any git command whose
 *    working directory is inside the repo — whether inherited from process.cwd,
 *    passed via .cwd(), or set with -C — fails with "not a git repository"
 *    instead of silently operating on real worktrees. Test repos in /tmp are
 *    not under the ceiling and work normally.
 *
 * 2. Environment sanitization clears every variable that could redirect git,
 *    shell, or wt operations to unexpected locations.
 *
 * 3. createTestDirectory() in test-repo.ts validates that the temp directory
 *    does not overlap the source checkout, and cleanup() refuses to delete
 *    paths that aren't wt-test-* children of tmpdir.
 *
 * 4. wt's own git helpers (runGit, git, gitSucceeds) are wrapped to reject any
 *    cwd at or below the checkout root. The ceiling only stops git walking *up*
 *    into the root; a command started exactly there still finds it.
 */
import { mock } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 1. Git discovery guard
// ---------------------------------------------------------------------------

// Clear vars that override repo discovery before using git to find the root.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

// Any git command whose working directory is at or below the repo root will
// walk upward and hit this ceiling before finding .git. Test repos created
// under os.tmpdir() are unaffected — /tmp is not under the ceiling.
process.env.GIT_CEILING_DIRECTORIES = repoRoot;

// ---------------------------------------------------------------------------
// 2. Environment sanitization
// ---------------------------------------------------------------------------
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

for (const key of ["BASH_ENV", "ENV", "TEMP", "TMP", "TMPDIR", "WT_AUTO_UPDATE", "WT_DIR"]) {
  delete process.env[key];
}

// ---------------------------------------------------------------------------
// 3. Process guards
// ---------------------------------------------------------------------------
process.chdir = ((directory: string) => {
  throw new Error(
    `[TEST SAFETY] process.chdir("${directory}") is blocked. Pass cwd as a parameter instead.`,
  );
}) as typeof process.chdir;

process.exit = ((code?: number) => {
  throw new Error(
    `[TEST SAFETY] process.exit(${code}) is blocked. Throw an error instead or use expect().toThrow().`,
  );
}) as typeof process.exit;

// ---------------------------------------------------------------------------
// 4. Host-checkout guard on wt's git helpers
// ---------------------------------------------------------------------------
// Capture the real functions before mocking: after mock.module the namespace
// import itself would resolve to the wrappers.
const { runGit, git, gitSucceeds, gitFailure } = await import("../src/git/run.ts");

function assertOutsideCheckout(cwd: string | undefined): void {
  const target = resolve(cwd ?? process.cwd());
  if (target === repoRoot || target.startsWith(`${repoRoot}/`)) {
    throw new Error(
      `[TEST SAFETY] git in ${target} targets this checkout. Build fixtures with createTestRepo().`,
    );
  }
}

// `async` so a violation rejects like any other git failure instead of throwing synchronously.
mock.module("../src/git/run.ts", () => ({
  gitFailure,
  runGit: async (args: string[], cwd?: string) => {
    assertOutsideCheckout(cwd);
    return runGit(args, cwd);
  },
  git: async (args: string[], cwd?: string) => {
    assertOutsideCheckout(cwd);
    return git(args, cwd);
  },
  gitSucceeds: async (args: string[], cwd?: string) => {
    assertOutsideCheckout(cwd);
    return gitSucceeds(args, cwd);
  },
}));
