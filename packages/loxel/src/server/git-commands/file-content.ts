import path from "node:path";

import { logger } from "../logger";
import { readOnlyGitEnv } from "./git-env";
import { runGit } from "./run-git";
import { validatePath, validateRefName } from "./validation";
import { validateWorktreePath } from "./worktree";

const log = logger.child("git");

export async function getFileContent(
  cwd: string,
  filePath: string,
  ref?: string,
  worktreePath?: string,
): Promise<string[]> {
  validatePath(filePath);
  if (ref) {
    validateRefName(ref);
  }
  if (worktreePath) await validateWorktreePath(worktreePath, cwd);

  const gitCwd = worktreePath ?? cwd;
  const refSpec = ref ? `${ref}:${filePath}` : filePath;
  const result = await runGit(["show", refSpec], {
    cwd: gitCwd,
    env: readOnlyGitEnv(),
    nothrow: true,
  });

  if (result.exitCode !== 0) {
    log.debug("git show could not read file content", {
      refSpec,
      cwd: gitCwd,
      stderr: result.stderr.trim(),
    });
    return [];
  }

  return result.stdout.split("\n");
}

export async function getFileLines(
  cwd: string,
  filePath: string,
  startLine: number,
  endLine: number,
  ref?: string,
): Promise<string[]> {
  const allLines = await getFileContent(cwd, filePath, ref);
  return allLines.slice(startLine - 1, endLine);
}

export async function getWorkingTreeFileContent(
  cwd: string,
  worktreePath: string,
  filePath: string,
): Promise<string[]> {
  validatePath(filePath);
  await validateWorktreePath(worktreePath, cwd);
  const fullPath = path.join(worktreePath, filePath);
  try {
    const content = await Bun.file(fullPath).text();
    return content.split("\n");
  } catch {
    return [];
  }
}

export async function writeWorkingTreeFileContent(
  cwd: string,
  worktreePath: string,
  filePath: string,
  content: string,
): Promise<void> {
  validatePath(filePath);
  await validateWorktreePath(worktreePath, cwd);
  const fullPath = path.join(worktreePath, filePath);
  await Bun.write(fullPath, content);
}
