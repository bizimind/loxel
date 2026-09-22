export {
  branchExists,
  deleteBranch,
  getCurrentBranch,
  renameBranch,
  resolveRemoteDefault,
} from "./branch.ts";
export {
  assertValidWorktreeName,
  branchNameError,
  structuralNameError,
  worktreeNameError,
} from "./name.ts";
export {
  assertCanTransformToBare,
  detectRepoType,
  ensureWorktreesDir,
  excludeWorktreesDir,
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
  pruneEmptyParents,
  removeWorktree,
  resolveRepoRoot,
  submodulesWithLocalOnlyCommits,
  upstreamDivergence,
  worktreeStatus,
  type GitProbe,
  type WorktreeStatus,
  worktreeContaining,
  worktreesDir,
  type Worktree,
} from "./worktree.ts";
