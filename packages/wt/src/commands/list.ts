import { createResult, formatTable, runAction } from "@bizimind/cli-common";

import type { ListResult } from "../types.ts";

import { getWorktreesDir, resolveConfig } from "../config/loader.ts";
import { listWorktrees } from "../worktree/git.ts";
import { getWorktreeName } from "../worktree/select.ts";
import { StateManager } from "../worktree/state.ts";

interface ListOptions {
  json?: boolean;
  repoPath?: string;
}

/**
 * List all worktrees with their status.
 */
export async function listCommand(options: ListOptions = {}): Promise<void> {
  await runAction<ListResult>(options, async () => {
    const { config, rootDir } = await resolveConfig(options.repoPath);
    const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });

    const worktrees = await listWorktrees(rootDir);
    const state = new StateManager(rootDir);
    const stateData = await state.getAll();

    // Filter to only show worktrees in our managed directory (exclude bare repo)
    const managedWorktrees = worktrees.filter((wt) => !wt.bare && wt.path.startsWith(worktreesDir));

    const result: ListResult = {
      worktrees: managedWorktrees.map((wt) => {
        const name = getWorktreeName(wt.path, worktreesDir);
        const index = stateData[name];
        return {
          name,
          path: wt.path,
          branch: wt.branch ?? "(detached)",
          portOffset: index === undefined ? 0 : index * config.port_offseting.offset,
        };
      }),
    };

    return createResult(result, formatListResult);
  });
}

function formatListResult(result: ListResult): string {
  if (result.worktrees.length === 0) {
    return "No worktrees found.\n\nCreate one with: wt add <name>";
  }

  return (
    "Worktrees:\n\n" +
    formatTable(result.worktrees, [
      { key: "name", label: "Name" },
      { key: "branch", label: "Branch" },
      { key: "path", label: "Path" },
      { key: "portOffset", label: "Offset", align: "right" },
    ])
  );
}
