/** Whether the user trusts a worktree's repository to run its code, and what waits on that. */
export interface RepoTrustStatus {
  /** The repository's folder, as the user knows it. */
  repository: string;
  trusted: boolean;
  /** What has run restricted for lack of trust since Loxel started, one sentence each. */
  restrictions: string[];
}

export interface SetRepoTrustRequest {
  worktreePath: string;
  trusted: boolean;
}
