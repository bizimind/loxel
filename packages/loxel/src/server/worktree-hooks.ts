/**
 * Worktree hooks (`init.wt.sh`, `clean.wt.sh`) are the repository's code, so Loxel runs them only
 * in a trusted repository, and the same goes for the git hooks and the programs the repository's
 * git config names, which the git commands of these operations would run. Every add, remove, bare
 * clone and `wt init` fix Loxel makes goes through here; the `wt` command line is the user's own
 * act and runs them as it always does. A bare clone is not restricted: its git config and hooks
 * come from git itself, not from the repository.
 */
import { existsSync } from "node:fs";

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
  withGitEnv,
} from "@bizimind/wt/lib";

import { untrustedChangeGitEnv } from "./git-commands";
import { isRepoTrusted, reportRepoRestriction, setRepoTrusted } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";

/** What an untrusted repository holds back, as the trust UI lists it. */
export const WORKTREE_HOOKS_RESTRICTION = "Worktree hooks (init.wt.sh, clean.wt.sh) don't run.";

/** The `wt init` fixes that contact origin, with the repository's own transport settings. */
const ORIGIN_FIXES: readonly InitActionId[] = ["fetch-refspec", "origin-head"];

type HookOptions = "hookEnv" | "allowHook";

/**
 * Run `fn`, wt operations on the repository at `repoPath`, with every git command they run kept
 * from running the repository's own programs unless it is trusted (`untrustedChangeGitEnv`).
 * `checkout` is the worktree whose submodules a check for uncommitted changes looks into, when it
 * is another one than `repoPath` and still exists. A checkout wt creates is filled in under the
 * env worked out from inside it, so config that applies only there (a conditional include on the
 * new worktree or branch) is covered too.
 */
export async function withRepoGitEnv<T>(
  repoPath: string,
  fn: () => Promise<T>,
  checkout: string = repoPath,
): Promise<T> {
  if (isRepoTrusted(repoPath)) return fn();
  const env = await untrustedChangeGitEnv(existsSync(checkout) ? checkout : repoPath);
  return withGitEnv(env, fn, untrustedChangeGitEnv);
}

/** Add a worktree, running `init.wt.sh` and the repository's git hooks only if it is trusted. */
export async function addWorktree(
  params: Omit<AddParams, HookOptions>,
  progress: ProgressHandler,
): Promise<AddResult> {
  const result = await withRepoGitEnv(params.repoPath, () =>
    executeAdd({ ...params, hookEnv: buildSpawnEnv(), allowHook: isRepoTrusted }, progress),
  );
  if (result.hookSkipped) reportRepoRestriction(result.path, WORKTREE_HOOKS_RESTRICTION);
  return result;
}

/**
 * Apply `wt init` fixes (`executeInit`), running `init.wt.sh` in a worktree one adds and the
 * repository's git hooks only if it is trusted. In an untrusted repository the fixes that contact
 * origin are skipped and reported as failed: the repository's git config decides how git reaches a
 * remote, which can run any program. `wt init` applies them once the user trusts the repository.
 */
export async function applyInitActions(
  repoPath: string,
  apply: InitActionId[],
  progress: ProgressHandler,
): Promise<InitResult> {
  const trusted = isRepoTrusted(repoPath);
  const held = trusted ? [] : apply.filter((id) => ORIGIN_FIXES.includes(id));
  const result = await withRepoGitEnv(repoPath, () =>
    executeInit(
      repoPath,
      {
        apply: apply.filter((id) => !held.includes(id)),
        hookEnv: buildSpawnEnv(),
        allowHook: isRepoTrusted,
      },
      progress,
    ),
  );
  const heldOutcomes = held.map((id) => ({
    id,
    status: "failed" as const,
    commands: [],
    error:
      "skipped because the repository is not trusted (it contacts origin with the repository's git settings); run `wt init` in the repository once you trust it",
  }));
  return reportHeldHooks({ ...result, outcomes: [...heldOutcomes, ...result.outcomes] });
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
 * nothing in it came from anyone else. Trust is given on the new worktree, and only then does
 * `init.wt.sh` run.
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
 * Remove a worktree, running `clean.wt.sh` and the repository's git hooks only if it is trusted.
 * Nothing is reported when the clean hook is held back: the removal dialog already said so, from
 * the plan's `cleanHookHeld`.
 */
export async function removeWorktree(
  params: Omit<RemoveParams, HookOptions>,
  progress: ProgressHandler,
): Promise<RemoveResult> {
  return withRepoGitEnv(
    params.repoPath,
    () =>
      executeRemove({ ...params, hookEnv: buildSpawnEnv(), allowHook: isRepoTrusted }, progress),
    params.expectedPath,
  );
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
