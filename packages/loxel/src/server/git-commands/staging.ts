import { logger } from "../logger";
import { SUBMODULE_GITLINK_ONLY, readOnlyGitEnv } from "./git-env";
import type { RunGitOptions } from "./run-git";
import { runGit } from "./run-git";
import { validatePath } from "./validation";

const log = logger.child("git");

export async function stageFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Staging ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await runGit(["add", "--", ...files], { cwd });
}

export async function unstageFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Unstaging ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await runGit(["restore", "--staged", "--", ...files], { cwd });
}

export async function stageHunk(cwd: string, patch: string): Promise<void> {
  const { exitCode, stderr } = await runGit(["apply", "--cached", "-"], {
    cwd,
    stdin: patch,
    nothrow: true,
  });
  if (exitCode !== 0) {
    throw new Error(`Failed to stage hunk: ${stderr || `exit code ${exitCode}`}`);
  }
}

export async function unstageHunk(cwd: string, patch: string): Promise<void> {
  const { exitCode, stderr } = await runGit(["apply", "--cached", "--reverse", "-"], {
    cwd,
    stdin: patch,
    nothrow: true,
  });
  if (exitCode !== 0) {
    throw new Error(`Failed to unstage hunk: ${stderr || `exit code ${exitCode}`}`);
  }
}

export async function discardChanges(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Discarding changes in ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await runGit(["checkout", "--", ...files], { cwd });
}

/**
 * Make files match HEAD again, discarding their staged and unstaged changes alike: tracked files
 * (including both sides of a staged rename, and staged deletions) are restored from HEAD, files
 * HEAD doesn't have are removed from the index and deleted, and untracked files are deleted.
 *
 * `files` are relative to the worktree root. Each is classified by git's own status, so a path
 * that already matches HEAD (e.g. a diff that went stale) is skipped instead of failing the batch.
 * Paths are literal (no glob matching), so a name like `*.ts` never touches other files.
 */
export async function revertToHead(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Reverting ${files.length} file(s) to HEAD`);
  for (const file of files) {
    validatePath(file);
  }

  const requested = new Set(files);
  const tracked: string[] = [];
  const untracked: string[] = [];
  const status = await runNamedGit(
    "git status",
    [
      ...SUBMODULE_GITLINK_ONLY,
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ],
    { cwd, env: readOnlyGitEnv() },
  );
  for (const entry of status.split("\0")) {
    const file = entry.slice(3);
    if (!requested.has(file)) continue;
    (entry.startsWith("??") ? untracked : tracked).push(file);
  }

  if (tracked.length > 0) {
    await runNamedGit(
      "git restore",
      [
        "--literal-pathspecs",
        "-C",
        cwd,
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { stdin: tracked.join("\0") },
    );
  }
  if (untracked.length > 0) {
    await runNamedGit("git clean", [
      "--literal-pathspecs",
      "-C",
      cwd,
      "clean",
      "--force",
      "--quiet",
      "--",
      ...untracked,
    ]);
  }
}

/** Run a git command, failing with its stderr (rather than just the exit code) and returning stdout. */
async function runNamedGit(
  name: string,
  args: readonly string[],
  options?: RunGitOptions,
): Promise<string> {
  const result = await runGit(args, { ...options, nothrow: true });
  if (result.exitCode !== 0) {
    throw new Error(`${name} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
