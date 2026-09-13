import { createResult, runAction } from "@bizimind/cli-common";

import { executeRemove, planRemove, type RemovePlan, type RemoveResult } from "../lib/index.ts";
import { confirmForceRemove, isTTY, selectRemoveAction } from "../prompt.ts";
import type { AbortedResult } from "./aborted.ts";
import { abortedResult } from "./aborted.ts";
import { resolveWorktreeName } from "./select.ts";

interface RemoveOptions {
  force?: boolean;
  deleteBranch?: boolean;
  keepBranch?: boolean;
  json?: boolean;
}

type RemoveCommandResult = RemoveResult | AbortedResult;

/** Remove a worktree after running clean.wt.sh. */
export async function removeCommand(
  name: string | undefined,
  options: RemoveOptions,
): Promise<void> {
  await runAction<RemoveCommandResult>(options, async (ctx) => {
    const repoPath = process.cwd();
    const selected = await resolveWorktreeName(name, "remove", repoPath);
    const plan = await planRemove({ name: selected, repoPath });

    if (plan.isMain) {
      throw new Error("Refusing to remove the main worktree.");
    }

    const deleteBranch = await decideBranchDeletion(plan, options);
    if (deleteBranch === "cancel") return abortedResult("User cancelled");

    const force = await decideForce(plan, options);
    if (force === "cancel") return abortedResult("User declined force removal");

    const result = await executeRemove(
      { name: selected, repoPath, deleteBranch, force },
      { log: ctx.log, warn: ctx.warn },
    );

    return createResult<RemoveResult>(result, (data) => {
      const branch = data.branchDeleted ? " and its branch" : "";
      return `Removed worktree '${data.name}'${branch}.`;
    });
  });
}

/** Flags win; otherwise ask when interactive, and keep the branch when not. */
async function decideBranchDeletion(
  plan: RemovePlan,
  options: RemoveOptions,
): Promise<boolean | "cancel"> {
  if (options.deleteBranch) return true;
  if (options.keepBranch || !plan.branch) return false;
  if (!isTTY()) return false;

  const action = await selectRemoveAction(plan.name, plan.branch);
  if (action === "cancel") return "cancel";
  return action === "remove-with-branch";
}

/** A dirty worktree needs --force, or a confirmation when interactive. */
async function decideForce(plan: RemovePlan, options: RemoveOptions): Promise<boolean | "cancel"> {
  if (options.force) return true;
  if (!plan.dirty) return false;

  if (!isTTY()) {
    throw new Error(
      `Worktree '${plan.name}' has uncommitted or untracked changes. Use --force to remove it.`,
    );
  }
  return (await confirmForceRemove(plan.name)) ? true : "cancel";
}
