import { $ } from "bun";

import { logger } from "../logger";
import { FSMONITOR, validatePath } from "./validation";

const log = logger.child("git");

export async function stageFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Staging ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await $`git ${FSMONITOR} -C ${cwd} add -- ${files}`.quiet();
}

export async function unstageFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  log.debug(`Unstaging ${files.length} file(s)`);
  for (const file of files) {
    validatePath(file);
  }
  await $`git ${FSMONITOR} -C ${cwd} restore --staged -- ${files}`.quiet();
}

export async function stageHunk(cwd: string, patch: string): Promise<void> {
  const proc = Bun.spawn(["git", ...FSMONITOR, "-C", cwd, "apply", "--cached", "-"], {
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
  const proc = Bun.spawn(["git", ...FSMONITOR, "-C", cwd, "apply", "--cached", "--reverse", "-"], {
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
  await $`git ${FSMONITOR} -C ${cwd} checkout -- ${files}`.quiet();
}
