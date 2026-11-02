/** What a file's project says about ESLint, read from disk without running anything. */
import path from "node:path";

import {
  hasInstalledPackage,
  isFile,
  notInstalledMessage,
  projectDirs,
  readPackageJson,
} from "./js-project";

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
  return hasInstalledPackage("eslint", file, wtPath);
}

/** What to tell the user about a project with an ESLint config and no ESLint installed. */
export function eslintNotInstalledMessage(configDir: string, wtPath: string): string {
  return notInstalledMessage(
    { name: "ESLint", packageName: "eslint", sign: "has a config" },
    configDir,
    wtPath,
  );
}
