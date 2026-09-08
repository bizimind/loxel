import { createResult, runAction } from "@bizimind/cli-common";

import { resolveConfig } from "../config/loader.ts";
import { isTTY } from "../init/detect.ts";
import { selectBranchExistsAction, inputWorktreeName } from "../init/prompts.ts";
import type { AddResult } from "../lib/add.ts";
import { planAdd, executeAdd } from "../lib/add.ts";
import type { AbortedResult } from "../types.ts";

interface AddOptions {
  open?: boolean;
  branch?: string;
  json?: boolean;
  repoPath?: string;
}

type AddCommandResult = AddResult | AbortedResult;

/**
 * Create a new worktree.
 */
export async function addCommand(
  providedName: string | undefined,
  options: AddOptions,
): Promise<void> {
  await runAction<AddCommandResult>(options, async (ctx) => {
    // Prompt for name if not provided
    let name = providedName;
    if (!name) {
      if (!isTTY()) {
        throw new Error("Worktree name required in non-interactive mode.\n\nUsage: wt add <name>");
      }
      name = await inputWorktreeName();
    }

    const loadedConfig = await resolveConfig(options.repoPath);
    const repoPath = loadedConfig.rootDir;

    const plan = await planAdd({ name, repoPath, loadedConfig });

    // Handle branch conflicts interactively
    let branchResolution: "use-existing" | "delete-and-create" | undefined;
    if (plan.branchConflict) {
      if (plan.branchConflict.kind === "used-by-worktree") {
        throw new Error(
          `A worktree already exists for branch '${name}' at: ${plan.branchConflict.worktreePath}`,
        );
      }

      // kind === "exists-unused"
      if (!isTTY()) {
        throw new Error(
          `Branch '${name}' already exists. Use '-b ${name}' to use it, or choose a different name.`,
        );
      }

      const action = await selectBranchExistsAction(name);
      if (action === "cancel") {
        return createResult<AbortedResult>(
          { aborted: true, reason: "User cancelled" },
          () => "Aborted.",
        );
      }
      branchResolution = action;
    }

    const progress = { log: ctx.log, warn: ctx.warn };
    const result = await executeAdd(
      {
        name,
        branch: options.branch,
        branchResolution,
        open: options.open,
        repoPath,
        loadedConfig,
      },
      progress,
    );

    return createResult<AddResult>(result, () => `\nWorktree '${name}' is ready!`);
  });
}
