import path from "node:path";

import { $ } from "bun";

import { validatePath, validateRefName } from "./validation";
import { validateWorktreePath } from "./worktree";

export async function getFileContent(
  cwd: string,
  filePath: string,
  ref?: string,
): Promise<string[]> {
  validatePath(filePath);
  if (ref) {
    validateRefName(ref);
  }

  const refSpec = ref ? `${ref}:${filePath}` : filePath;
  const result = await $`git -C ${cwd} show ${refSpec}`.nothrow().text();

  if (result.startsWith("fatal:")) {
    return [];
  }

  return result.split("\n");
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
