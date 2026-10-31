import { fetchJson, withScope } from "./client";
import type { RepoTrustStatus, SetRepoTrustRequest } from "./repo-trust-model";

export async function getRepoTrust(worktreePath: string): Promise<RepoTrustStatus> {
  return fetchJson<RepoTrustStatus>(withScope("/repo-trust", { wt: worktreePath }));
}

export async function setRepoTrust(request: SetRepoTrustRequest): Promise<RepoTrustStatus> {
  return fetchJson<RepoTrustStatus>("/repo-trust", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
