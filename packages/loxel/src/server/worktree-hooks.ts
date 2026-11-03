/**
 * Worktree hooks (`init.wt.sh`, `clean.wt.sh`) are the repository's code, so Loxel runs them only
 * in a trusted repository. Every add and remove Loxel makes goes through here; the `wt` command
 * line is the user's own act and runs them as it always does.
 */
import {
  executeAdd,
  executeRemove,
  HOOK_INIT,
  runInitHook,
  type AddParams,
  type AddResult,
  type ProgressHandler,
  type RemoveParams,
  type RemoveResult,
} from "@bizimind/wt/lib";

import { isRepoTrusted, reportRepoRestriction } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";

/** What an untrusted repository holds back, as the trust UI lists it. */
export const WORKTREE_HOOKS_RESTRICTION = "Worktree hooks (init.wt.sh, clean.wt.sh) don't run.";

type HookOptions = "hookEnv" | "allowHook";

/** Add a worktree, running `init.wt.sh` only if the repository is trusted. */
export async function addWorktree(
  params: Omit<AddParams, HookOptions>,
  progress: ProgressHandler,
): Promise<AddResult> {
  const result = await executeAdd(
    { ...params, hookEnv: buildSpawnEnv(), allowHook: isRepoTrusted },
    progress,
  );
  if (result.hookSkipped) reportRepoRestriction(result.path, WORKTREE_HOOKS_RESTRICTION);
  return result;
}

/**
 * Remove a worktree, running `clean.wt.sh` only if the repository is trusted. Nothing is reported
 * when it is held back: the removal dialog already said so, from the plan's `cleanHookHeld`.
 */
export async function removeWorktree(
  params: Omit<RemoveParams, HookOptions>,
  progress: ProgressHandler,
): Promise<RemoveResult> {
  return executeRemove({ ...params, hookEnv: buildSpawnEnv(), allowHook: isRepoTrusted }, progress);
}

/** Whether removing a worktree would hold back its repository's `clean.wt.sh`. */
export function isCleanHookHeld(worktreePath: string, hasHook: boolean): boolean {
  return hasHook && !isRepoTrusted(worktreePath);
}

/**
 * Run `init.wt.sh` in a worktree whose creation held it back, once the user has trusted the
 * repository. Throws when it still is not trusted.
 */
export async function runHeldInitHook(
  params: { name: string; repoPath: string; worktreePath: string },
  progress: ProgressHandler,
): Promise<boolean> {
  if (!isRepoTrusted(params.worktreePath)) {
    throw new Error(`${HOOK_INIT} did not run: hooks run in trusted repositories.`);
  }
  return runInitHook(
    { name: params.name, repoPath: params.repoPath, hookEnv: buildSpawnEnv() },
    progress,
  );
}
