import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function expandHome(inputPath: string): string {
  if (!inputPath.startsWith("~/")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(2));
}

export function isPathWithin(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function normalizeWorkspacePath(workspaceRoot: string, candidate: string): string {
  if (path.isAbsolute(candidate)) {
    return path.normalize(candidate);
  }
  return path.normalize(path.join(workspaceRoot, candidate));
}

async function resolvePathForContainment(
  targetPath: string,
  options?: { allowMissingLeaf?: boolean },
): Promise<string | null> {
  try {
    return await realpath(targetPath);
  } catch {
    if (!options?.allowMissingLeaf) {
      return null;
    }
  }

  const parent = path.dirname(targetPath);
  try {
    const resolvedParent = await realpath(parent);
    return path.join(resolvedParent, path.basename(targetPath));
  } catch {
    return null;
  }
}

export async function isPathWithinResolved(
  baseDir: string,
  targetPath: string,
  options?: { allowMissingLeaf?: boolean },
): Promise<boolean> {
  let resolvedBase: string;
  try {
    resolvedBase = await realpath(baseDir);
  } catch {
    return false;
  }

  const resolvedTarget = await resolvePathForContainment(targetPath, options);
  if (!resolvedTarget) {
    return false;
  }

  return isPathWithin(resolvedBase, resolvedTarget);
}
