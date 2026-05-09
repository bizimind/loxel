import { Glob } from "bun";
import { existsSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Matches a hex commit hash (4–40 chars). */
export const REF_PATTERN = /^[a-f0-9]{4,40}$/i;

/**
 * Stable prefix for internal temp worktrees: sha256("loxel").slice(0, 16).
 * Collision-proof against user-created branch/worktree names.
 */
export const INTERNAL_WORKTREE_PREFIX = "88bcefd59a302cd0-";

/**
 * Symlink node_modules directories from the source repo into a worktree.
 * Handles root node_modules and workspace package node_modules.
 */
export async function symlinkNodeModules(sourceRoot: string, worktreeRoot: string): Promise<void> {
  const dirs = await findNodeModulesDirs(sourceRoot);

  for (const dir of dirs) {
    const relPath = relative(sourceRoot, dir);
    const target = join(worktreeRoot, relPath);

    // Ensure parent directory exists
    const parentDir = dirname(target);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Skip if already exists (e.g. checked-in node_modules, unlikely but safe)
    if (existsSync(target)) continue;

    try {
      symlinkSync(dir, target, "dir");
    } catch {
      // Non-fatal — package may just have missing type info
    }
  }
}

/**
 * Find all node_modules directories that should be symlinked.
 * Reads workspaces from root package.json to find package directories.
 */
async function findNodeModulesDirs(sourceRoot: string): Promise<string[]> {
  const dirs: string[] = [];

  // Root node_modules
  const rootNM = join(sourceRoot, "node_modules");
  if (existsSync(rootNM) && !isSymlink(rootNM)) {
    dirs.push(rootNM);
  }

  // Read workspaces from package.json
  const pkgJsonPath = join(sourceRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return dirs;

  let workspaces: string[];
  try {
    const pkgJson = await Bun.file(pkgJsonPath).json();
    workspaces = Array.isArray(pkgJson.workspaces) ? pkgJson.workspaces : [];
  } catch {
    return dirs;
  }

  // Resolve workspace globs to find package directories with node_modules
  for (const pattern of workspaces) {
    const glob = new Glob(`${pattern}/package.json`);
    for await (const match of glob.scan({ cwd: sourceRoot, absolute: false })) {
      const pkgDir = dirname(match);
      const nmDir = join(sourceRoot, pkgDir, "node_modules");
      if (existsSync(nmDir) && !isSymlink(nmDir)) {
        dirs.push(nmDir);
      }
    }
  }

  return dirs;
}

/**
 * Find all workspace packages in a monorepo.
 * Reads `workspaces` from root package.json, resolves globs, and returns
 * each package's name and relative directory.
 */
export async function findWorkspacePackages(
  sourceRoot: string,
): Promise<Array<{ name: string; relativeDir: string }>> {
  const pkgJsonPath = join(sourceRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return [];

  let workspaces: string[];
  try {
    const pkgJson = await Bun.file(pkgJsonPath).json();
    workspaces = Array.isArray(pkgJson.workspaces) ? pkgJson.workspaces : [];
  } catch {
    return [];
  }

  const results: Array<{ name: string; relativeDir: string }> = [];

  for (const pattern of workspaces) {
    const glob = new Glob(`${pattern}/package.json`);
    for await (const match of glob.scan({ cwd: sourceRoot, absolute: false })) {
      const relativeDir = dirname(match);
      const absPath = join(sourceRoot, match);
      try {
        const pkg = await Bun.file(absPath).json();
        const name = typeof pkg.name === "string" ? pkg.name : relativeDir;
        results.push({ name, relativeDir });
      } catch {
        results.push({ name: relativeDir, relativeDir });
      }
    }
  }

  results.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir));
  return results;
}

function isSymlink(path: string): boolean {
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
