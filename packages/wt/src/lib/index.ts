/**
 * Public library API for @bizimind/wt.
 *
 * Everything here works configless and against both bare and non-bare
 * repositories: git itself is the source of truth.
 */

export { executeAdd, planAdd } from "./add.ts";
export type { AddParams, AddPlan, AddResult, BranchConflict } from "./add.ts";
export { executeMove, planMove } from "./move.ts";
export type { BranchSkipReason, MoveParams, MovePlan, MoveResult, MoveTarget } from "./move.ts";
export { executeRemove, planRemove } from "./remove.ts";
export type { RemoveParams, RemovePlan, RemoveResult } from "./remove.ts";
export { currentManagedWorktree, listManagedWorktrees, resolveWorktreesDir } from "./worktrees.ts";
export type { ManagedWorktree } from "./worktrees.ts";

export { silentProgress } from "../progress.ts";
export type { ProgressHandler } from "../progress.ts";

export { getWorktreeName } from "../git/index.ts";
export {
  assertCanTransformToBare,
  detectRepoType,
  ensureWorktreesDir,
  getCurrentBranch,
  hasUncommittedChanges,
  initBareRepo,
  transformToBare,
} from "../git/index.ts";
export type { RepoType } from "../git/index.ts";

export { HOOK_CLEAN, HOOK_INIT, HOOK_RENAME } from "../hooks/run.ts";
