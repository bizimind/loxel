import { $ } from "bun";

import type { StatusInfo } from "@/api/git-models";

import { parseStatusOutput } from "../parsers/status";
import { readOnlyGitEnv } from "./git-env";

/**
 * The single status reader: the status broadcast, the file-tree decorations and the
 * cross-worktree dirty indicators are all derived from this one command.
 */
export async function getStatus(cwd: string): Promise<StatusInfo> {
  const result = await $`git -C ${cwd} status --porcelain=v2 --branch -z`
    .env(readOnlyGitEnv())
    .text();
  return parseStatusOutput(result);
}
