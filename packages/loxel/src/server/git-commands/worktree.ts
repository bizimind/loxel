import { $ } from "bun";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { StatusInfo, WorktreeEntry, WorktreeStatusInfo } from "@/api/git-models";

import { logger } from "../logger";
import { parseStatusOutput } from "../parsers/status";
import { INTERNAL_WORKTREE_PREFIX } from "../worktree-utils";
import { FSMONITOR } from "./validation";

const log = logger.child("git");

export async function validateWorktreePath(worktreePath: string, cwd: string): Promise<void> {
  const resolved = path.resolve(worktreePath);
  const worktrees = await getWorktrees(cwd);
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

export async function getWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const result = await $`git -C ${cwd} worktree list --porcelain`.text();
  const entries = parseWorktreeListOutput(result);

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

export async function getWorktreeStatus(worktreePath: string): Promise<StatusInfo> {
  const result = await $`git ${FSMONITOR} -C ${worktreePath} status --porcelain=v2 --branch`.text();
  return parseStatusOutput(result);
}

export async function getDirtyWorktreeStatuses(
  cwd: string,
  worktrees?: WorktreeEntry[],
): Promise<WorktreeStatusInfo[]> {
  const allWorktrees = worktrees ?? (await getWorktrees(cwd));

  const userWorktrees = allWorktrees.filter(
    (wt) => !path.basename(wt.path).startsWith(INTERNAL_WORKTREE_PREFIX),
  );

  const indexed = await Promise.all(
    userWorktrees.map(async (wt, i) => {
      try {
        const status = await getWorktreeStatus(wt.path);
        const isDirty =
          status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0;
        if (isDirty) {
          return {
            index: i,
            info: {
              path: wt.path,
              branch: wt.branch,
              commit: status.commit,
              isMain: wt.isMain,
              staged: status.staged,
              unstaged: status.unstaged,
              untracked: status.untracked,
            } satisfies WorktreeStatusInfo,
          };
        }
      } catch {
        // Skip worktrees that can't be queried (e.g. pruned)
      }
      return null;
    }),
  );

  return indexed
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.index - b.index)
    .map((r) => r.info);
}
