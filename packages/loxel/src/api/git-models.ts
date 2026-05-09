/** Information about a single commit */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  parents: string[];
  message: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  committerDate: string;
  refs: RefInfo[];
  /** Present only on virtual "uncommitted changes" rows */
  uncommitted?: UncommittedInfo;
}

/** A git reference (branch, tag, HEAD) */
export interface RefInfo {
  name: string;
  type: "head" | "remote" | "tag" | "HEAD";
  /** For remote branches: origin/main -> "origin" */
  remote?: string;
  /** Commit hash this ref points to */
  commit: string;
  /** For branches: upstream ref (e.g., origin/main) */
  upstream?: string;
  /** Commits ahead of upstream */
  ahead?: number;
  /** Commits behind upstream */
  behind?: number;
}

/** Branch information including tracking status */
export interface BranchInfo {
  name: string;
  commit: string;
  isHead: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  lastUpdated?: string; // ISO timestamp of last ref update
}

/** Working tree status */
export interface StatusInfo {
  branch: string | null;
  commit: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  conflicted: FileStatus[];
}

/** Status of a single file */
export interface FileStatus {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "U";
}

/** Stash entry */
export interface StashInfo {
  index: number;
  message: string;
  commit: string;
  date: string;
}

/** Uncommitted changes metadata attached to a virtual commit */
export interface UncommittedInfo {
  worktreePath: string;
  branch: string | null;
  stagedCount: number;
  unstagedCount: number;
}

/** A git worktree entry from `git worktree list` */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  commit: string;
  isMain: boolean;
  /** ISO timestamp of worktree directory creation (from fs stat birthtime) */
  createdAt: string | null;
  /** wt directory-based name (only present for wt-managed worktrees). */
  wtName?: string;
  /** True for optimistic entries that haven't been confirmed by the server yet. */
  pending?: boolean;
}

/** Worktree status with dirty file details */
export interface WorktreeStatusInfo {
  path: string;
  branch: string | null;
  commit: string;
  isMain: boolean;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
}

/** Combined commits + refs response from /api/graph */
export interface GraphData {
  commits: CommitInfo[];
  refs: RefInfo[];
}

/** Prefix for virtual uncommitted commit hashes */
export const UNCOMMITTED_PREFIX = "uncommitted:";

/** Check if a hash represents a virtual uncommitted commit */
export function isUncommittedHash(hash: string): boolean {
  return hash.startsWith(UNCOMMITTED_PREFIX);
}
