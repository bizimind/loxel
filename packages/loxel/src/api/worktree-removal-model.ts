import type { RemovePlan, RemoveResult } from "@bizimind/wt/lib";

/** A worktree nested below the one being removed. */
export interface NestedWorktreePlan {
  path: string;
  /** Has uncommitted or untracked files: removing it too needs force */
  dirty: boolean;
}

/** Response of POST /api/worktree/plan-remove. */
export interface WorktreeRemovePlan extends RemovePlan {
  /** Every worktree nested below it, at any depth */
  nested: NestedWorktreePlan[];
}

/**
 * What removing a worktree does with the worktrees nested below it: `move-up` nests its children
 * under its own parent (or the top level), `remove` removes them all with it.
 */
export type NestedRemoval = "move-up" | "remove";

/** Response of POST /api/worktree/remove. */
export interface WorktreeRemoveResult extends RemoveResult {
  /** Set when the worktree was removed but some of its children could not be moved up */
  warning?: string;
}
