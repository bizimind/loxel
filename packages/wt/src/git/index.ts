export { branchExists, deleteBranch, getCurrentBranch, renameBranch } from "./branch.ts";
export { assertValidWorktreeName, structuralNameError, worktreeNameError } from "./name.ts";
export {
  assertCanTransformToBare,
  detectRepoType,
  ensureWorktreesDir,
  hasUncommittedChanges,
  initBareRepo,
  transformToBare,
  type RepoType,
} from "./repo.ts";
export { git, gitFailure, gitSucceeds, runGit, type GitResult } from "./run.ts";
export {
  addWorktree,
  canonicalWorktreesDir,
  DETACHED,
  findWorktree,
  getManagedWorktrees,
  getWorktreeName,
  isWorktreeDirty,
  listWorktrees,
  moveWorktree,
  parseWorktreeList,
  pathExists,
  removeWorktree,
  resolveRepoRoot,
  upstreamDivergence,
  worktreeChanges,
  worktreeContaining,
  worktreesDir,
  type Worktree,
} from "./worktree.ts";
