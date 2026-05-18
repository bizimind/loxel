import {
  createResult,
  formatKeyValue,
  formatSection,
  formatSections,
  runAction,
} from "@bizimind/cli-common";

import type { ViewResult } from "../types.ts";
import { computeAllEnvVars } from "../worktree/env.ts";
import { isSynced } from "../worktree/git.ts";
import { loadWorktreeContext, selectWorktree } from "../worktree/select.ts";
import { StateManager } from "../worktree/state.ts";

interface ViewOptions {
  json?: boolean;
  repoPath?: string;
}

/**
 * View detailed information about a worktree.
 */
export async function viewCommand(name?: string, options: ViewOptions = {}): Promise<void> {
  await runAction<ViewResult>(options, async () => {
    const wtCtx = await loadWorktreeContext({ repoPath: options.repoPath });

    const { worktree, name: selectedName } = await selectWorktree(wtCtx, name, {
      promptMessage: "Select a worktree to view:",
      nonInteractiveUsage: "Usage: wt view <name>",
    });

    const result = await buildViewResult(wtCtx, worktree, selectedName);
    return createResult(result, formatViewResult);
  });
}

async function buildViewResult(
  wtCtx: Awaited<ReturnType<typeof loadWorktreeContext>>,
  worktree: Awaited<ReturnType<typeof selectWorktree>>["worktree"],
  name: string,
): Promise<ViewResult> {
  const state = new StateManager(wtCtx.rootDir);
  const index = (await state.getIndex(name)) ?? 0;
  const env = computeAllEnvVars(name, worktree.path, wtCtx.rootDir, index, wtCtx.config);
  const synced = await isSynced(worktree.path);

  return {
    name,
    path: worktree.path,
    branch: worktree.branch ?? "(detached)",
    head: worktree.head.slice(0, 7),
    portOffset: index * wtCtx.config.port_offseting.offset,
    synced,
    env,
  };
}

function formatViewResult(result: ViewResult): string {
  const info = formatKeyValue({
    branch: result.branch,
    head: result.head,
    path: result.path,
    offset: result.portOffset,
    synced: result.synced ? "Yes" : "No",
  });

  const envSection =
    Object.keys(result.env).length > 0
      ? formatSection(
          "Environment",
          Object.entries(result.env)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
        )
      : null;

  return formatSections(`Worktree: ${result.name}\n\n${info}`, envSection);
}
