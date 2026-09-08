import path from "node:path";

import { $ } from "bun";

import { readOnlyGitEnv } from "./git-env";

export async function isBareRepo(cwd: string): Promise<boolean> {
  const result = await $`git -C ${cwd} rev-parse --is-bare-repository`.env(readOnlyGitEnv()).text();
  return result.trim() === "true";
}

export async function getGitRoot(cwd: string): Promise<string> {
  try {
    const result = await $`git -C ${cwd} rev-parse --show-toplevel`.env(readOnlyGitEnv()).text();
    return result.trim();
  } catch {
    // Bare repos don't have a working tree — use the git-common-dir as the root
    const result = await $`git -C ${cwd} rev-parse --git-common-dir`.env(readOnlyGitEnv()).text();
    const trimmed = result.trim();
    return trimmed.startsWith("/") ? trimmed : path.resolve(cwd, trimmed);
  }
}
