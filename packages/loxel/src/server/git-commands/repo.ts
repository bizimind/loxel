import path from "node:path";

import { $ } from "bun";

export async function isBareRepo(cwd: string): Promise<boolean> {
  const result = await $`git -C ${cwd} rev-parse --is-bare-repository`.text();
  return result.trim() === "true";
}

export async function getGitRoot(cwd: string): Promise<string> {
  try {
    const result = await $`git -C ${cwd} rev-parse --show-toplevel`.text();
    return result.trim();
  } catch {
    // Bare repos don't have a working tree — use the git-common-dir as the root
    const result = await $`git -C ${cwd} rev-parse --git-common-dir`.text();
    const trimmed = result.trim();
    return trimmed.startsWith("/") ? trimmed : path.resolve(cwd, trimmed);
  }
}
