import { createResult, formatTable, runAction } from "@bizimind/cli-common";

import {
  canonicalWorktreesDir,
  DETACHED,
  getWorktreeName,
  listWorktrees,
  resolveRepoRoot,
  type WorktreeMeta,
} from "../git/index.ts";
import { readWorktreesMeta } from "../lib/index.ts";

interface ListOptions {
  json?: boolean;
}

interface ListedWorktree {
  name: string;
  path: string;
  branch: string;
  /** HEAD commit hash */
  head: string;
  /** The main worktree (or the bare repo's own entry) */
  main: boolean;
  /** Whether the worktree is locked */
  locked: boolean;
  /** Worktree metadata, `wt-id` included; empty while metadata is off */
  meta: WorktreeMeta;
}

export interface ListResult {
  worktrees: ListedWorktree[];
}

/** List every worktree git knows about. */
export async function listCommand(options: ListOptions = {}): Promise<void> {
  await runAction<ListResult>(options, async (ctx) => {
    const root = await resolveRepoRoot(process.cwd());
    const dir = await canonicalWorktreesDir(root);
    const worktrees = await listWorktrees(root);
    // Only JSON reports metadata; the table would read every worktree's config for nothing.
    const meta = options.json
      ? await readWorktreesMeta(root, worktrees, ctx.warn)
      : new Map<string, WorktreeMeta>();

    const result: ListResult = {
      worktrees: worktrees
        .filter((wt) => !wt.bare)
        .map((wt) => ({
          name: getWorktreeName(wt.path, dir),
          path: wt.path,
          branch: wt.branch ?? DETACHED,
          head: wt.head,
          main: wt.path === root,
          locked: wt.locked,
          meta: meta.get(wt.path) ?? {},
        })),
    };

    return createResult(result, formatListResult);
  });
}

function formatListResult(result: ListResult): string {
  if (result.worktrees.length === 0) {
    return "No worktrees found.\n\nCreate one with: wt add <name>";
  }

  const rows = result.worktrees.map((wt) => ({
    name: wt.name,
    branch: wt.branch,
    path: wt.main ? `${wt.path} *` : wt.path,
  }));

  const table = formatTable(rows, [
    { key: "name", label: "Name" },
    { key: "branch", label: "Branch" },
    { key: "path", label: "Path" },
  ]);

  // A bare repo has no main worktree, so the legend would explain nothing.
  return result.worktrees.some((wt) => wt.main) ? `${table}\n\n* main worktree` : table;
}
