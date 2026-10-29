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
export { executeRemove, forceReason, lockedMessage, planRemove } from "./remove.ts";
export type { RemoveParams, RemovePlan, RemoveResult } from "./remove.ts";
export {
  currentManagedWorktree,
  findWorktreeById,
  listManagedWorktrees,
  resolveWorktreesDir,
} from "./worktrees.ts";
export type { ManagedWorktree } from "./worktrees.ts";
export {
  ensureWorktreeId,
  getWorktreeMeta,
  isWorktreeMetadataEnabled,
  METADATA_OFF_MESSAGE,
  parseMetaAssignments,
  readWorktreesMeta,
  setWorktreeMeta,
  unsetWorktreeMeta,
  writableMetaKey,
} from "./meta.ts";
export type { MetaParams, WorktreeMetaResult } from "./meta.ts";
export { CLONE_ACTIONS, cloneBareRepo, diagnose, executeInit, planInit } from "./init.ts";
export type {
  ActionOutcome,
  CloneParams,
  Diagnosis,
  InitDecisions,
  InitPlan,
  InitResult,
} from "./init.ts";
export { INIT_ACTION_ORDER } from "./checks.ts";
export type { Check, CheckId, CheckStatus, InitAction, InitActionId } from "./checks.ts";
export { shellQuote } from "./shell-quote.ts";

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
export type { RepoType, WorktreeMeta } from "../git/index.ts";
export { WORKTREE_ID_KEY } from "../git/index.ts";

export { HOOK_CLEAN, HOOK_INIT, HOOK_RENAME } from "../hooks/run.ts";
