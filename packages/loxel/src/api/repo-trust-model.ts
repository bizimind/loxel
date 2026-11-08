/**
 * The user's answer about a repository: trusted, declined (they said "Not Now" or stopped trusting
 * it), or nothing yet. Declined is untrusted like undecided; it only keeps Loxel from nagging.
 */
export type RepoTrustDecision = "trusted" | "declined" | "undecided";

/** Whether the user trusts a worktree's repository to run its code, and what waits on that. */
export interface RepoTrustStatus {
  /** The repository's folder, as the user knows it. */
  repository: string;
  /** The answer that applies to the repository's folder as it is now. */
  decision: RepoTrustDecision;
  /** What has run restricted for lack of trust since Loxel started, one sentence each. */
  restrictions: string[];
}

/** A repository in Settings > Security: a project's, or one with a stored answer. */
export interface RepoTrustEntry {
  /** What the answer is stored under, which also names the repository to forget. */
  id: string;
  repository: string;
  /** A worktree of a project in this repository, to answer through; null when no project uses it. */
  worktreePath: string | null;
  /** The stored answer, whether or not it still applies. */
  decision: RepoTrustDecision;
  /** The stored answer no longer applies: the folder is gone, or another one replaced it. */
  stale: boolean;
  restrictions: string[];
}

export interface RepoTrustListResponse {
  repositories: RepoTrustEntry[];
}

/** Answer for a worktree's repository, or forget a stored answer by its repository id. */
export type SetRepoTrustRequest =
  | { worktreePath: string; decision: RepoTrustDecision }
  | { repositoryId: string; decision: "undecided" };
