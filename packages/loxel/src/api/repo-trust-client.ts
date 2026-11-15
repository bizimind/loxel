import { fetchJson, withScope } from "./client";
import type {
  RepoTrustListResponse,
  RepoTrustStatus,
  SetRepoTrustRequest,
} from "./repo-trust-model";

export async function getRepoTrust(worktreePath: string): Promise<RepoTrustStatus> {
  return fetchJson<RepoTrustStatus>(withScope("/repo-trust", { wt: worktreePath }));
}

/** Every project's repository and every stored answer, for Settings > Security. */
export async function listRepoTrust(): Promise<RepoTrustListResponse> {
  return fetchJson<RepoTrustListResponse>("/repo-trust/list");
}

export async function setRepoTrust(
  request: Extract<SetRepoTrustRequest, { worktreePath: string }>,
): Promise<RepoTrustStatus> {
  return fetchJson<RepoTrustStatus>("/repo-trust", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/** Clear the stored answer for a repository, so Loxel asks again. */
export async function forgetRepoTrust(repositoryId: string): Promise<void> {
  const request: SetRepoTrustRequest = { repositoryId, decision: "undecided" };
  await fetchJson<{ success: boolean }>("/repo-trust", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
