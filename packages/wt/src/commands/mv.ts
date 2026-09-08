import { createResult, runAction } from "@bizimind/cli-common";

import {
  currentManagedWorktree,
  executeMove,
  planMove,
  type MovePlan,
  type MoveResult,
} from "../lib/index.ts";
import type { ProgressHandler } from "../progress.ts";
import { confirmRename, inputNewWorktreeName, isTTY } from "../prompt.ts";
import type { AbortedResult } from "./aborted.ts";
import { abortedResult } from "./aborted.ts";
import { resolveWorktreeName } from "./select.ts";

interface MoveOptions {
  branch?: string;
  keepBranch?: boolean;
  force?: boolean;
  json?: boolean;
}

type MoveCommandResult = MoveResult | AbortedResult;

/** Rename a worktree and its branch, then run rename.wt.sh at the new path. */
export async function mvCommand(names: string[], options: MoveOptions): Promise<void> {
  await runAction<MoveCommandResult>(options, async (ctx) => {
    if (names.length > 2) {
      throw new Error("Usage: wt mv [<old>] <new>");
    }
    if (options.branch && options.keepBranch) {
      throw new Error("--branch and --keep-branch are mutually exclusive.");
    }

    const repoPath = process.cwd();
    // Capture the cwd before the move: afterwards the old directory is gone.
    const cwdBefore = process.cwd();

    const { oldName, newName } = await resolveNames(names, repoPath);
    const plan = await planMove({
      oldName,
      name: newName,
      repoPath,
      branch: options.branch,
      keepBranch: options.keepBranch,
    });

    if (plan.isMain) {
      throw new Error("Refusing to rename the main worktree.");
    }
    // Nothing was given on the command line, so show what the rename changes.
    if (names.length === 0 && !(await confirmPlan(plan, ctx))) {
      return abortedResult("User cancelled");
    }

    const result = await executeMove(
      {
        oldName,
        name: newName,
        repoPath,
        branch: options.branch,
        keepBranch: options.keepBranch,
        force: options.force ?? false,
      },
      { log: ctx.log, warn: ctx.warn },
    );

    warnStaleCwd(cwdBefore, result, ctx);

    return createResult<MoveResult>(
      result,
      (data) => `Renamed '${data.oldName}' -> '${data.name}' at ${data.path}`,
    );
  });
}

/**
 * Resolve (old, new) from 0, 1, or 2 positional names.
 *
 * Two names are explicit. One name is the new name for the worktree holding
 * the cwd, falling back to the picker when the cwd is outside them all. Zero
 * names prompts for the new one too.
 */
async function resolveNames(
  names: string[],
  repoPath: string,
): Promise<{ oldName: string; newName: string }> {
  const [first, second] = names;
  if (first !== undefined && second !== undefined) {
    return { oldName: first, newName: second };
  }

  const oldName = await resolveOldName(repoPath);
  if (first !== undefined) return { oldName, newName: first };

  return { oldName, newName: await promptNewName(oldName) };
}

/** The worktree holding the cwd, or one picked from the list. */
async function resolveOldName(repoPath: string): Promise<string> {
  const current = await currentManagedWorktree(repoPath, process.cwd());
  if (current) return current.name;
  return resolveWorktreeName(undefined, "rename", repoPath);
}

async function promptNewName(oldName: string): Promise<string> {
  if (!isTTY()) {
    throw new Error("New name required in non-interactive mode.\n\nUsage: wt mv [<old>] <new>");
  }
  const newName = await inputNewWorktreeName(oldName);
  if (newName === oldName) {
    throw new Error("No new name given.");
  }
  return newName;
}

/** Show what the rename will change, then confirm it. */
async function confirmPlan(plan: MovePlan, progress: ProgressHandler): Promise<boolean> {
  progress.log(`  path:   ${plan.oldPath} -> ${plan.worktreePath}`);
  const branch =
    plan.newBranch && plan.newBranch !== plan.oldBranch
      ? `${plan.oldBranch} -> ${plan.newBranch}`
      : `${plan.oldBranch} (unchanged)`;
  progress.log(`  branch: ${branch}`);

  if (!isTTY()) return true;
  return confirmRename(plan.oldName, plan.name);
}

/**
 * Point the user at the new path when their shell is left in the old one.
 *
 * Nothing a CLI can do fixes its parent shell's cwd, so the `wtm` wrapper from
 * wt.sh sets WT_SHELL_WRAPPER and does the cd itself; without it, print the
 * command. Other terminals sitting in the old path always have to move
 * themselves — nothing can reach them from here.
 */
function warnStaleCwd(cwd: string, result: MoveResult, progress: ProgressHandler): void {
  if (process.env.WT_SHELL_WRAPPER) return;
  if (cwd !== result.oldPath && !cwd.startsWith(`${result.oldPath}/`)) return;

  // Keep the subdirectory they were standing in.
  const suffix = cwd.slice(result.oldPath.length);
  progress.warn(`Your shell is still in the old path; run: cd ${shellQuote(result.path + suffix)}`);
}

/** Quote an arbitrary path as one POSIX-shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
