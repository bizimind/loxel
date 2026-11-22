import { withScope } from "./client";
import type {
  RepoTrustListResponse,
  RepoTrustStatus,
  SetRepoTrustRequest,
} from "./repo-trust-model";
import { connectionOf } from "./server-connection";
import type { ServerId, WorktreeRef } from "./worktree-ref";

/** What to answer for: a worktree's repository, or a repository folder not added as a project yet. */
export type RepoTrustTarget = WorktreeRef | { server: ServerId; repository: string };

export async function getRepoTrust(target: RepoTrustTarget): Promise<RepoTrustStatus> {
  const path =
    "path" in target
      ? withScope("/repo-trust", { wt: target.path })
      : `/repo-trust?${new URLSearchParams({ repo: target.repository })}`;
  return connectionOf(target.server).fetchJson<RepoTrustStatus>(path);
}

/** Every project's repository on `server` and every answer it stores, for Settings > Security. */
export async function listRepoTrust(server: ServerId): Promise<RepoTrustListResponse> {
  return connectionOf(server).fetchJson<RepoTrustListResponse>("/repo-trust/list");
}

export async function setRepoTrust(
  target: RepoTrustTarget,
  choice: Omit<Extract<SetRepoTrustRequest, { worktreePath: string }>, "worktreePath">,
): Promise<RepoTrustStatus> {
  const request: SetRepoTrustRequest =
    "path" in target
      ? { worktreePath: target.path, ...choice }
      : { repositoryPath: target.repository, ...choice };
  return connectionOf(target.server).fetchJson<RepoTrustStatus>("/repo-trust", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/** Clear the stored answer for a repository of `server`, so Loxel asks again. */
export async function forgetRepoTrust(server: ServerId, repositoryId: string): Promise<void> {
  const request: SetRepoTrustRequest = { repositoryId, decision: "undecided" };
  await connectionOf(server).fetchJson<{ success: boolean }>("/repo-trust", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
