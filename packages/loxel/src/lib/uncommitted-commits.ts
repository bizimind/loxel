import type { CommitInfo, RefInfo, WorktreeStatusInfo } from "@/api/git-models";
import { UNCOMMITTED_PREFIX } from "@/api/git-models";

/**
 * Build a summary message for uncommitted changes.
 */
function buildUncommittedMessage(staged: number, unstaged: number, untracked: number): string {
  const parts: string[] = [];
  if (staged > 0) parts.push(`${staged} staged`);
  if (unstaged > 0) parts.push(`${unstaged} modified`);
  if (untracked > 0) parts.push(`${untracked} untracked`);
  return parts.join(", ") || "uncommitted changes";
}

/**
 * Create a virtual CommitInfo for uncommitted changes.
 */
export function createVirtualCommit(
  parentHash: string,
  worktreePath: string,
  branch: string | null,
  stagedCount: number,
  unstagedCount: number,
  untrackedCount: number,
): CommitInfo {
  const hash = `${UNCOMMITTED_PREFIX}${worktreePath}`;
  const refs: RefInfo[] = [];
  if (branch) {
    refs.push({ name: branch, type: "head", commit: hash });
  }
  return {
    hash,
    shortHash: "",
    parents: [parentHash],
    message: buildUncommittedMessage(stagedCount, unstagedCount, untrackedCount),
    author: "",
    authorEmail: "",
    authorDate: "",
    committer: "",
    committerEmail: "",
    committerDate: "",
    refs,
    uncommitted: {
      worktreePath,
      branch,
      stagedCount,
      unstagedCount: unstagedCount + untrackedCount,
    },
  };
}

/**
 * Inject virtual "uncommitted changes" commits into the commit list.
 *
 * For each dirty worktree, creates a virtual commit that appears just before
 * its parent (the branch tip) in the list. Returns a new array — does not
 * mutate the input.
 */
export function injectUncommittedCommits(
  commits: CommitInfo[],
  worktreeStatuses: WorktreeStatusInfo[],
): CommitInfo[] {
  if (worktreeStatuses.length === 0) return commits;

  const seenWorktrees = new Set<string>();
  const virtualCommits: CommitInfo[] = [];

  // Worktree statuses (includes the current worktree if dirty)
  for (const wt of worktreeStatuses) {
    if (seenWorktrees.has(wt.path)) continue;
    seenWorktrees.add(wt.path);

    virtualCommits.push(
      createVirtualCommit(
        wt.commit,
        wt.path,
        wt.branch,
        wt.staged.length,
        wt.unstaged.length,
        wt.untracked.length,
      ),
    );
  }

  if (virtualCommits.length === 0) return commits;

  // Build index of parent hashes to their positions
  const commitIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (c) commitIndex.set(c.hash, i);
  }

  // Only include virtual commits whose parent is in the visible list
  const validVirtuals = virtualCommits.filter((vc) => {
    const parentHash = vc.parents[0];
    return parentHash !== undefined && commitIndex.has(parentHash);
  });

  if (validVirtuals.length === 0) return commits;

  // Insert each virtual commit just before its parent
  // Sort by parent index descending so insertions don't shift earlier indices
  validVirtuals.sort((a, b) => {
    const aIdx = commitIndex.get(a.parents[0]!) ?? 0;
    const bIdx = commitIndex.get(b.parents[0]!) ?? 0;
    return bIdx - aIdx;
  });

  const result = [...commits];
  for (const vc of validVirtuals) {
    const parentIdx = commitIndex.get(vc.parents[0]!);
    if (parentIdx !== undefined) {
      result.splice(parentIdx, 0, vc);
    }
  }

  return result;
}
