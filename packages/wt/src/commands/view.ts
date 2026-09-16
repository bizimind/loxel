import { createResult, formatKeyValue } from "@bizimind/cli-common";

import {
  canonicalWorktreesDir,
  DETACHED,
  findWorktree,
  listWorktrees,
  resolveRepoRoot,
  upstreamDivergence,
  worktreeStatus,
} from "../git/index.ts";
import { runCommand } from "./aborted.ts";
import { resolveWorktreeName } from "./select.ts";

interface ViewOptions {
  json?: boolean;
}

export interface ViewResult {
  name: string;
  path: string;
  branch: string;
  head: string;
  main: boolean;
  /** Whether the worktree is locked */
  locked: boolean;
  /** Number of uncommitted or untracked files, or null when the status could not be read */
  dirty: number | null;
  /** Commits ahead of upstream, or null when there is no upstream */
  ahead: number | null;
  /** Commits behind upstream, or null when there is no upstream */
  behind: number | null;
}

/** Show one worktree's details. */
export async function viewCommand(name?: string, options: ViewOptions = {}): Promise<void> {
  await runCommand<ViewResult>(options, async (ctx) => {
    const repoPath = process.cwd();
    const selected = await resolveWorktreeName(name, "view", repoPath);

    const root = await resolveRepoRoot(repoPath);
    const dir = await canonicalWorktreesDir(root);
    const worktree = findWorktree(await listWorktrees(root), dir, selected);
    if (!worktree) {
      throw new Error(`Worktree '${selected}' not found.`);
    }

    const [status, divergence] = await Promise.all([
      worktreeStatus(worktree.path),
      upstreamDivergence(worktree.path),
    ]);
    if (!status.ok) ctx.warn(`Could not read the status of ${worktree.path}: ${status.reason}`);

    const result: ViewResult = {
      name: selected,
      path: worktree.path,
      branch: worktree.branch ?? DETACHED,
      head: worktree.head.slice(0, 12),
      main: worktree.path === root,
      locked: worktree.locked,
      dirty: status.ok ? status.changes.length : null,
      ahead: divergence?.ahead ?? null,
      behind: divergence?.behind ?? null,
    };

    return createResult(result, formatViewResult);
  });
}

function formatViewResult(result: ViewResult): string {
  const info: Record<string, string | number> = {
    branch: result.branch,
    head: result.head,
    path: result.path,
    main: result.main ? "yes" : "no",
    locked: result.locked ? "yes" : "no",
    dirty: result.dirty === null ? "unknown" : `${result.dirty} change(s)`,
  };
  if (result.ahead !== null && result.behind !== null) {
    info.upstream = `+${result.ahead} / -${result.behind}`;
  }

  return `Worktree: ${result.name}\n\n${formatKeyValue(info)}`;
}
