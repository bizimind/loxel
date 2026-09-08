import { createResult, runAction } from "@bizimind/cli-common";

import type { AddResult } from "../lib/index.ts";
import { executeAdd, planAdd } from "../lib/index.ts";
import { inputWorktreeName, isTTY, selectBranchExistsAction } from "../prompt.ts";
import type { AbortedResult } from "./aborted.ts";
import { abortedResult } from "./aborted.ts";

interface AddOptions {
  branch?: string;
  json?: boolean;
}

type AddCommandResult = AddResult | AbortedResult;

/** Create a worktree at `<worktreesDir>/<name>` and run init.wt.sh. */
export async function addCommand(
  providedName: string | undefined,
  options: AddOptions,
): Promise<void> {
  await runAction<AddCommandResult>(options, async (ctx) => {
    const name = providedName ?? (await promptForName());
    const repoPath = process.cwd();

    const plan = await planAdd({ name, repoPath });
    const resolution = await resolveBranchConflict(plan, options);
    if (resolution === "cancel") return abortedResult("User cancelled");

    const result = await executeAdd(
      { name, repoPath, branch: options.branch, branchResolution: resolution },
      { log: ctx.log, warn: ctx.warn },
    );

    return createResult<AddResult>(
      result,
      (data) => `\nWorktree '${data.name}' is ready at ${data.path}`,
    );
  });
}

async function promptForName(): Promise<string> {
  if (!isTTY()) {
    throw new Error("Worktree name required in non-interactive mode.\n\nUsage: wt add <name>");
  }
  return inputWorktreeName();
}

/**
 * Decide what to do about an existing branch: nothing to do when there is no
 * conflict or when `-b` picked a branch explicitly.
 */
async function resolveBranchConflict(
  plan: Awaited<ReturnType<typeof planAdd>>,
  options: AddOptions,
): Promise<"use-existing" | "delete-and-create" | "cancel" | undefined> {
  const conflict = plan.branchConflict;
  if (!conflict || options.branch) return undefined;

  if (conflict.kind === "used-by-worktree") {
    throw new Error(`Branch '${plan.branch}' is already checked out at ${conflict.worktreePath}`);
  }
  if (!isTTY()) {
    throw new Error(
      `Branch '${plan.branch}' already exists. Use '-b ${plan.branch}' to check it out, or choose a different name.`,
    );
  }
  return selectBranchExistsAction(plan.branch);
}
