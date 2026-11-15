/**
 * Worktree hooks (`init.wt.sh`, `clean.wt.sh`) are the repository's code, so Loxel runs them only
 * in a trusted repository. Every add, remove, bare clone and `wt init` fix Loxel makes goes through
 * here; the `wt` command line is the user's own act and runs them as it always does.
 */
import {
  cloneBareRepo,
  executeAdd,
  executeInit,
  executeRemove,
  HOOK_INIT,
  runInitHook,
  type AddParams,
  type AddResult,
  type CloneParams,
  type InitActionId,
  type InitResult,
  type ProgressHandler,
  type RemoveParams,
  type RemoveResult,
} from "@bizimind/wt/lib";

import { isRepoTrusted, reportRepoRestriction, setRepoTrusted } from "./repo-trust";
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
 * Apply `wt init` fixes (`executeInit`), running `init.wt.sh` in a worktree one adds only if the
 * repository is trusted.
 */
export async function applyInitActions(
  repoPath: string,
  apply: InitActionId[],
  progress: ProgressHandler,
): Promise<InitResult> {
  return reportHeldHooks(
    await executeInit(
      repoPath,
      { apply, hookEnv: buildSpawnEnv(), allowHook: isRepoTrusted },
      progress,
    ),
  );
}

/**
 * Bare-clone a repository set up the way `wt init <url>` does it (`cloneBareRepo`), running
 * `init.wt.sh` in a worktree a setup action adds only if the repository is trusted.
 */
export async function cloneRepository(
  params: Omit<CloneParams, HookOptions>,
  progress: ProgressHandler,
): Promise<InitResult> {
  return reportHeldHooks(
    await cloneBareRepo(
      { ...params, hookEnv: buildSpawnEnv(), allowHook: isRepoTrusted },
      progress,
    ),
  );
}

function reportHeldHooks(result: InitResult): InitResult {
  for (const { worktree } of result.outcomes) {
    if (worktree?.hookSkipped) reportRepoRestriction(worktree.path, WORKTREE_HOOKS_RESTRICTION);
  }
  return result;
}

/**
 * Add the first worktree of a repository Loxel has just created from scratch, which starts trusted:
 * nothing in it came from anyone else. Trust is given on the new worktree, since a bare root does
 * not stand for the repository its worktrees belong to, and only then does `init.wt.sh` run.
 */
export async function addFirstWorktreeOfNewRepo(
  params: Omit<AddParams, HookOptions>,
  progress: ProgressHandler,
): Promise<AddResult> {
  const { hookSkipped, ...created } = await executeAdd(
    { ...params, hookEnv: buildSpawnEnv(), allowHook: () => false },
    progress,
  );
  setRepoTrusted(created.path, true);
  if (!hookSkipped) return created;
  const hookRan = await runInitHook(
    { name: params.name, repoPath: params.repoPath, hookEnv: buildSpawnEnv() },
    progress,
  );
  return { ...created, hookRan };
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
    {
      name: params.name,
      repoPath: params.repoPath,
      expectedPath: params.worktreePath,
      hookEnv: buildSpawnEnv(),
    },
    progress,
  );
}
