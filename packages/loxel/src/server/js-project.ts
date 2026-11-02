/** What a JavaScript project's files say about the tools it uses, read without running anything. */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { dirsUpToRoot } from "./language-formatter";
import { isInside } from "./shipped-by-repo";

/** The commands of each package manager, by its lockfile, first match per directory. */
const PACKAGE_MANAGERS = [
  { lockfiles: ["pnpm-lock.yaml"], install: "pnpm install", addDev: "pnpm add -D" },
  { lockfiles: ["yarn.lock"], install: "yarn install", addDev: "yarn add -D" },
  { lockfiles: ["bun.lock", "bun.lockb"], install: "bun install", addDev: "bun add -d" },
  { lockfiles: ["package-lock.json"], install: "npm install", addDev: "npm install --save-dev" },
];
const DEFAULT_PACKAGE_MANAGER = PACKAGE_MANAGERS[3]!;

export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readPackageJson(dir: string): Record<string, unknown> | null {
  const text = readConfigFile(path.join(dir, "package.json"));
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The directories to look in for `file`, or none for a file that is not the project's own: outside
 * the worktree, a dependency, or in a repository nested in the worktree, whose trust is its own.
 */
export function projectDirs(file: string, wtPath: string): string[] {
  if (!isInside(file, wtPath)) return [];
  if (file.split(path.sep).includes("node_modules")) return [];
  const dirs = dirsUpToRoot(path.dirname(file), wtPath);
  return dirs.some((dir) => dir !== path.resolve(wtPath) && existsSync(path.join(dir, ".git")))
    ? []
    : dirs;
}

/** Whether the worktree's `node_modules` has this package where `file` resolves it. */
export function hasInstalledPackage(packageName: string, file: string, wtPath: string): boolean {
  return projectDirs(file, wtPath).some((dir) =>
    isFile(path.join(dir, "node_modules", packageName, "package.json")),
  );
}

/** Whether the manifest lists this package as one the project itself uses. */
export function namesDependency(
  manifest: Record<string, unknown> | null,
  packageName: string,
): boolean {
  return [manifest?.dependencies, manifest?.devDependencies].some(
    (deps) => isRecord(deps) && deps[packageName] !== undefined,
  );
}

/** What to tell the user about a project that uses a tool it has not installed. */
export function notInstalledMessage(
  { name, packageName, sign }: { name: string; packageName: string; sign: string },
  dir: string,
  wtPath: string,
): string {
  const dirs = dirsUpToRoot(dir, wtPath);
  const manager =
    dirs
      .flatMap((candidate) =>
        PACKAGE_MANAGERS.filter(({ lockfiles }) =>
          lockfiles.some((lockfile) => isFile(path.join(candidate, lockfile))),
        ),
      )
      .at(0) ?? DEFAULT_PACKAGE_MANAGER;
  const named = dirs.some((candidate) => namesDependency(readPackageJson(candidate), packageName));
  const command = named ? manager.install : `${manager.addDev} ${packageName}`;
  return `${path.basename(dir)} ${sign}, but ${name} isn't installed. Run \`${command}\` in that folder.`;
}
