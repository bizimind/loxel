import { createResult, formatKeyValue } from "@bizimind/cli-common";

import {
  canonicalWorktreesDir,
  DETACHED,
  findWorktree,
  listWorktrees,
  resolveRepoRoot,
  upstreamDivergence,
  worktreeStatus,
  type WorktreeMeta,
} from "../git/index.ts";
import { readWorktreesMeta } from "../lib/index.ts";
import { runCommand } from "./aborted.ts";
import { formatMeta } from "./meta.ts";
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
  /** Worktree metadata, `wt-id` included; empty while metadata is off */
  meta: WorktreeMeta;
}

/** Show one worktree's details. */
export async function viewCommand(name?: string, options: ViewOptions = {}): Promise<void> {
  await runCommand<ViewResult>(options, async (ctx) => {
    const repoPath = process.cwd();
    const selected = await resolveWorktreeName(name, "view", repoPath);

    const root = await resolveRepoRoot(repoPath);
    const dir = await canonicalWorktreesDir(root);
    const worktrees = await listWorktrees(root);
    const worktree = findWorktree(worktrees, dir, selected);
    if (!worktree) {
      throw new Error(`Worktree '${selected}' not found.`);
    }

    const [status, divergence, meta] = await Promise.all([
      worktreeStatus(worktree.path),
      upstreamDivergence(worktree.path),
      readWorktreesMeta(root, worktrees, ctx.warn),
    ]);
    if (!status.ok) ctx.warn(`Could not read the status of ${worktree.path}: ${status.reason}`);

    const result: ViewResult = {
      name: selected,
      path: worktree.path,
      branch: worktree.branch ?? DETACHED,
      head: worktree.head.slice(0, 12),
      main: worktree.path === root,
      locked: worktree.locked,
      dirty: status.ok ? status.value.length : null,
      ahead: divergence?.ahead ?? null,
      behind: divergence?.behind ?? null,
      meta: meta.get(worktree.path) ?? {},
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

  const details = `Worktree: ${result.name}\n\n${formatKeyValue(info)}`;
  if (Object.keys(result.meta).length === 0) return details;
  return `${details}\n\nMetadata:\n\n${formatMeta(result.meta)}`;
}
