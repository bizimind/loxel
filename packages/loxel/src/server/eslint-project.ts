/** What a file's project says about ESLint, read from disk without running anything. */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { dirsUpToRoot } from "./language-formatter";
import { isInside } from "./shipped-by-repo";

const CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.mjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
];

/**
 * Worktree-relative globs of the files whose change can change what ESLint reports: its configs,
 * `package.json` for `eslintConfig` and a project becoming one, and the legacy ignore file.
 */
export const ESLINT_CONFIG_GLOBS: readonly string[] = [
  ...CONFIG_FILES.map((file) => `**/${file}`),
  "**/package.json",
  "**/.eslintignore",
];

/** The commands of each package manager, by its lockfile, first match per directory. */
const PACKAGE_MANAGERS = [
  { lockfiles: ["pnpm-lock.yaml"], install: "pnpm install", addEslint: "pnpm add -D eslint" },
  { lockfiles: ["yarn.lock"], install: "yarn install", addEslint: "yarn add -D eslint" },
  { lockfiles: ["bun.lock", "bun.lockb"], install: "bun install", addEslint: "bun add -d eslint" },
  {
    lockfiles: ["package-lock.json"],
    install: "npm install",
    addEslint: "npm install --save-dev eslint",
  },
];
const DEFAULT_PACKAGE_MANAGER = PACKAGE_MANAGERS[3]!;

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readPackageJson(dir: string): Record<string, unknown> | null {
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
function projectDirs(file: string, wtPath: string): string[] {
  if (!isInside(file, wtPath)) return [];
  if (file.split(path.sep).includes("node_modules")) return [];
  const dirs = dirsUpToRoot(path.dirname(file), wtPath);
  return dirs.some((dir) => dir !== path.resolve(wtPath) && existsSync(path.join(dir, ".git")))
    ? []
    : dirs;
}

/** The nearest directory from `file` up to the worktree holding an ESLint config. */
export function findEslintConfigDir(file: string, wtPath: string): string | null {
  for (const dir of projectDirs(file, wtPath)) {
    if (CONFIG_FILES.some((name) => isFile(path.join(dir, name)))) return dir;
    if (readPackageJson(dir)?.eslintConfig !== undefined) return dir;
  }
  return null;
}

/** Whether the worktree's `node_modules` has an ESLint that `file` resolves to. */
export function hasInstalledEslint(file: string, wtPath: string): boolean {
  return projectDirs(file, wtPath).some((dir) =>
    isFile(path.join(dir, "node_modules", "eslint", "package.json")),
  );
}

function namesEslint(manifest: Record<string, unknown> | null): boolean {
  return [manifest?.dependencies, manifest?.devDependencies].some(
    (deps) => isRecord(deps) && deps.eslint !== undefined,
  );
}

/** What to tell the user about a project with an ESLint config and no ESLint installed. */
export function eslintNotInstalledMessage(configDir: string, wtPath: string): string {
  const dirs = dirsUpToRoot(configDir, wtPath);
  const manager =
    dirs
      .flatMap((dir) =>
        PACKAGE_MANAGERS.filter(({ lockfiles }) =>
          lockfiles.some((name) => isFile(path.join(dir, name))),
        ),
      )
      .at(0) ?? DEFAULT_PACKAGE_MANAGER;
  const command = dirs.some((dir) => namesEslint(readPackageJson(dir)))
    ? manager.install
    : manager.addEslint;
  return `${path.basename(configDir)} has a config, but ESLint isn't installed. Run \`${command}\` in that folder.`;
}
