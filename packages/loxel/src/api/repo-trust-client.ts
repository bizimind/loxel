import { withScope } from "./client";
import type {
  RepoTrustListResponse,
  RepoTrustStatus,
  SetRepoTrustRequest,
} from "./repo-trust-model";
import { connectionOf } from "./server-connection";
import type { ServerId, WorktreeRef } from "./worktree-ref";

export async function getRepoTrust(wt: WorktreeRef): Promise<RepoTrustStatus> {
  return connectionOf(wt.server).fetchJson<RepoTrustStatus>(
    withScope("/repo-trust", { wt: wt.path }),
  );
}

/** Every project's repository on `server` and every answer it stores, for Settings > Security. */
export async function listRepoTrust(server: ServerId): Promise<RepoTrustListResponse> {
  return connectionOf(server).fetchJson<RepoTrustListResponse>("/repo-trust/list");
}

export async function setRepoTrust(
  wt: WorktreeRef,
  choice: Omit<Extract<SetRepoTrustRequest, { worktreePath: string }>, "worktreePath">,
): Promise<RepoTrustStatus> {
  const request: SetRepoTrustRequest = { worktreePath: wt.path, ...choice };
  return connectionOf(wt.server).fetchJson<RepoTrustStatus>("/repo-trust", {
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
