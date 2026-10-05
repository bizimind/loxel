import { $ } from "bun";

import { logger } from "../logger";
import { validatePath } from "./validation";

const log = logger.child("git");

export async function stageFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Staging ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await $`git -C ${cwd} add -- ${files}`.quiet();
}

export async function unstageFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Unstaging ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await $`git -C ${cwd} restore --staged -- ${files}`.quiet();
}

export async function stageHunk(cwd: string, patch: string): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "apply", "--cached", "-"], {
    stdin: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(patch);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to stage hunk: ${stderr || `exit code ${exitCode}`}`);
  }
}

export async function unstageHunk(cwd: string, patch: string): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "apply", "--cached", "--reverse", "-"], {
    stdin: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(patch);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to unstage hunk: ${stderr || `exit code ${exitCode}`}`);
  }
}

export async function discardChanges(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Discarding changes in ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await $`git -C ${cwd} checkout -- ${files}`.quiet();
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
  const status = await runGit(
    $`git -C ${cwd} status --porcelain -z --untracked-files=all --no-renames`,
    "git status",
  );
  for (const entry of status.split("\0")) {
    const file = entry.slice(3);
    if (!requested.has(file)) continue;
    (entry.startsWith("??") ? untracked : tracked).push(file);
  }

  if (tracked.length > 0) {
    await runGit(
      $`git --literal-pathspecs -C ${cwd} restore --source=HEAD --staged --worktree --pathspec-from-file=- --pathspec-file-nul < ${Buffer.from(tracked.join("\0"))}`,
      "git restore",
    );
  }
  if (untracked.length > 0) {
    await runGit(
      $`git --literal-pathspecs -C ${cwd} clean --force --quiet -- ${untracked}`,
      "git clean",
    );
  }
}

/** Run a git command, failing with its stderr (rather than just the exit code) and returning stdout. */
async function runGit(command: $.ShellPromise, name: string): Promise<string> {
  const result = await command.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${name} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}
