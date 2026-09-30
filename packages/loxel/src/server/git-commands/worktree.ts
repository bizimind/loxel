import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { $ } from "bun";

import type { StatusInfo, WorktreeEntry, WorktreeStatusInfo } from "@/api/git-models";

import { logger } from "../logger";
import { INTERNAL_WORKTREE_PREFIX } from "../worktree-utils";
import { mapWithConcurrency } from "./concurrency";
import { readOnlyGitEnv } from "./git-env";
import { getStatus } from "./status";

const log = logger.child("git");

export async function validateWorktreePath(worktreePath: string, cwd: string): Promise<void> {
  const resolved = path.resolve(worktreePath);
  const worktrees = await listWorktrees(cwd);
  const isKnown = worktrees.some((wt) => path.resolve(wt.path) === resolved);
  if (!isKnown) {
    throw new Error(`Invalid worktree path: ${worktreePath}`);
  }
}

export function parseWorktreeListOutput(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> & { bare?: boolean } = {};
  let isFirst = true;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        if (!current.bare) {
          entries.push({
            path: current.path,
            branch: current.branch ?? null,
            commit: current.commit ?? "",
            isMain: current.isMain ?? false,
            createdAt: null,
          });
        }
      }
      current = { path: line.slice("worktree ".length), isMain: isFirst };
      isFirst = false;
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = null;
    } else if (line === "bare") {
      current.bare = true;
    }
  }

  if (current.path && !current.bare) {
    entries.push({
      path: current.path,
      branch: current.branch ?? null,
      commit: current.commit ?? "",
      isMain: current.isMain ?? false,
      createdAt: null,
    });
  }

  return entries;
}

/** `git worktree list`, parsed. Unlike {@link getWorktrees} it does not stat each directory. */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const result = await $`git -C ${cwd} worktree list --porcelain`.env(readOnlyGitEnv()).text();
  return parseWorktreeListOutput(result);
}

export async function getWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const entries = await listWorktrees(cwd);

  return Promise.all(
    entries.map(async (entry) => {
      try {
        const stats = await stat(entry.path);
        return { ...entry, createdAt: stats.birthtime.toISOString() };
      } catch (err) {
        log.warn("Failed to stat worktree directory", { error: err, path: entry.path });
        return entry;
      }
    }),
  );
}

/** The dirty summary of one worktree's status, or null when it has nothing uncommitted. */
export function toDirtyWorktreeStatus(
  worktree: Pick<WorktreeEntry, "path" | "isMain">,
  status: StatusInfo,
): WorktreeStatusInfo | null {
  const isDirty =
    status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0;
  if (!isDirty) return null;
  return {
    path: worktree.path,
    branch: status.branch,
    commit: status.commit,
    isMain: worktree.isMain,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
  };
}

export interface WorktreeStatusProbe {
  worktree: WorktreeEntry;
  /** Dirty summary; null when clean or deleted; undefined when the status could not be read. */
  status: WorktreeStatusInfo | null | undefined;
}

export interface ReadWorktreeStatusesOptions {
  /** A status already known to be current (e.g. kept live by watchers); skips running git. */
  liveStatus?: (worktreePath: string) => StatusInfo | undefined;
}

/**
 * Every git status is a full working-tree scan, and a status in a superproject also runs one
 * per submodule. Running one per worktree all at once turned every sweep into a burst of
 * dozens of concurrent scans, so they are spread over a small pool instead.
 */
const STATUS_SWEEP_CONCURRENCY = 6;

/**
 * Read the status of every user worktree of a project, in `git worktree list` order.
 *
 * A worktree whose status cannot be read is reported as `undefined` rather than dropped: the
 * caller must not mistake a transient failure for "clean" and hide a dirty indicator.
 */
export async function readWorktreeStatuses(
  cwd: string,
  options: ReadWorktreeStatusesOptions = {},
): Promise<WorktreeStatusProbe[]> {
  const worktrees = (await listWorktrees(cwd)).filter(
    (wt) => !path.basename(wt.path).startsWith(INTERNAL_WORKTREE_PREFIX),
  );

  return mapWithConcurrency(worktrees, STATUS_SWEEP_CONCURRENCY, async (worktree) => {
    const live = options.liveStatus?.(worktree.path);
    if (live) return { worktree, status: toDirtyWorktreeStatus(worktree, live) };
    try {
      return { worktree, status: toDirtyWorktreeStatus(worktree, await getStatus(worktree.path)) };
    } catch (err) {
      // Deleted but not yet pruned: git still lists it, and it has nothing uncommitted to show.
      if (!existsSync(worktree.path)) return { worktree, status: null };
      log.warn("Failed to read worktree status", { error: err, path: worktree.path });
      return { worktree, status: undefined };
    }
  });
}
