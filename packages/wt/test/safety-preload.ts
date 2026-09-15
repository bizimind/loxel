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
 */
import { execSync } from "node:child_process";

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
