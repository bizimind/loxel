import type { StatusInfo } from "@/api/git-models";

import { parseStatusOutput } from "../parsers/status";
import { SUBMODULE_GITLINK_ONLY, readOnlyGitEnv } from "./git-env";
import { gitText } from "./run-git";

/**
 * The single status reader: the status broadcast, the file-tree decorations and the
 * cross-worktree dirty indicators are all derived from this one command.
 */
export async function getStatus(cwd: string): Promise<StatusInfo> {
  const result = await gitText(
    [...SUBMODULE_GITLINK_ONLY, "status", "--porcelain=v2", "--branch", "-z"],
    { cwd, env: readOnlyGitEnv() },
  );
  return parseStatusOutput(result);
}
