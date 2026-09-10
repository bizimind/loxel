import { createResult, runAction, type OutputContext } from "@bizimind/cli-common";

import { resolveConfig } from "../config/loader.ts";
import type { WorktreeStatus } from "../init/detect.ts";
import { isTTY } from "../init/detect.ts";
import { confirmForceRemove, selectRemoveAction } from "../init/prompts.ts";
import type { RemoveResult, RemovePlan } from "../lib/remove.ts";
import { planRemove, executeRemove } from "../lib/remove.ts";
import type { AbortedResult } from "../types.ts";
import { loadWorktreeContext, selectWorktree } from "../worktree/select.ts";

interface RemoveOptions {
  force?: boolean;
  json?: boolean;
  repoPath?: string;
}

type RemoveCommandResult = RemoveResult | AbortedResult;

/**
 * Remove a worktree.
 */
export async function removeCommand(
  name: string | undefined,
  options: RemoveOptions,
): Promise<void> {
  await runAction<RemoveCommandResult>(options, async (ctx) => {
    const loadedConfig = await resolveConfig(options.repoPath);
    const repoPath = loadedConfig.rootDir;

    // Select worktree by name or interactively
    let selectedName = name;
    if (!selectedName) {
      const wtCtx = await loadWorktreeContext({ repoPath });
      const result = await selectWorktree(wtCtx, undefined, {
        promptMessage: "Select a worktree to remove:",
        nonInteractiveUsage: "Usage: wt rm <name>",
        noWorktreesMessage: "No worktrees exist to remove.",
      });
      selectedName = result.name;
    }

    const plan = await planRemove({ name: selectedName, repoPath, loadedConfig });

    // In TTY mode, prompt for remove action (remove-with-branch / remove-only / cancel)
    let shouldDeleteBranch: boolean;
    if (isTTY()) {
      const action = await selectRemoveAction(plan.name, plan.branch);
      if (action === "cancel") {
        return createResult<AbortedResult>(
          { aborted: true, reason: "User cancelled" },
          () => "Aborted.",
        );
      }
      shouldDeleteBranch = action === "remove-with-branch";
    } else {
      shouldDeleteBranch = plan.branchDeletionApplicable;
    }

    // Safety check for dirty state
    let force = options.force ?? false;
    if (!force && plan.status) {
      printWorktreeWarnings(ctx, plan);

      if (isTTY()) {
        const confirmed = await confirmForceRemove(selectedName);
        if (!confirmed) {
          return createResult<AbortedResult>(
            { aborted: true, reason: "User declined force removal" },
            () => "Aborted.",
          );
        }
      } else {
        throw new Error("Use --force to remove worktree with local changes");
      }

      force = true;
    }

    const progress = { log: ctx.log, warn: ctx.warn };
    const result = await executeRemove(
      { name: selectedName, deleteBranch: shouldDeleteBranch, force, repoPath, loadedConfig },
      progress,
    );

    return createResult<RemoveResult>(result, () => `Worktree '${selectedName}' removed.`);
  });
}

/**
 * Print worktree warnings using the output context.
 */
function printWorktreeWarnings(ctx: OutputContext, plan: RemovePlan): void {
  const status = plan.status;
  if (!status) return;

  ctx.warn("");
  ctx.warn(`Warning: Worktree '${plan.name}' has local changes that will be lost:`);
  ctx.warn("");

  printUntrackedWarnings(ctx, status);
  printUncommittedWarnings(ctx, status);
  printBranchWarnings(ctx, plan.branch, status);
}

function printUntrackedWarnings(ctx: OutputContext, status: WorktreeStatus): void {
  if (status.untrackedFiles.length === 0) return;

  ctx.warn(`  Untracked files (${status.untrackedFiles.length}):`);
  const maxFiles = 5;
  const filesToShow = status.untrackedFiles.slice(0, maxFiles);
  for (const file of filesToShow) {
    ctx.warn(`    - ${file}`);
  }
  if (status.untrackedFiles.length > maxFiles) {
    ctx.warn(`    (and ${status.untrackedFiles.length - maxFiles} more)`);
  }
  ctx.warn("");
}

function printUncommittedWarnings(ctx: OutputContext, status: WorktreeStatus): void {
  if (status.stagedCount === 0 && status.unstagedCount === 0) return;

  ctx.warn("  Uncommitted changes:");
  if (status.stagedCount > 0) {
    ctx.warn(`    - ${status.stagedCount} file${status.stagedCount === 1 ? "" : "s"} staged`);
  }
  if (status.unstagedCount > 0) {
    ctx.warn(`    - ${status.unstagedCount} file${status.unstagedCount === 1 ? "" : "s"} modified`);
  }
  ctx.warn("");
}

function printBranchWarnings(
  ctx: OutputContext,
  branchName: string | null,
  status: WorktreeStatus,
): void {
  if (branchName === null) return;

  if (status.aheadCount === null) {
    ctx.warn("  Branch status:");
    ctx.warn(`    - Branch '${branchName}' has never been pushed`);
    ctx.warn("");
  } else if (status.aheadCount > 0) {
    ctx.warn("  Unpushed commits:");
    ctx.warn(`    - ${status.aheadCount} commit${status.aheadCount === 1 ? "" : "s"} not pushed`);
    ctx.warn("");
  }
}
