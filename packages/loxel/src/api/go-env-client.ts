import { fetchJson, withScope } from "./client";
import type {
  GoEnvResponse,
  GoToolchainCandidatesResponse,
  GoToolchainChoiceRequest,
} from "./go-env-model";

export async function getGoEnv(worktreePath: string): Promise<GoEnvResponse> {
  return fetchJson<GoEnvResponse>(withScope("/go-env", { wt: worktreePath }));
}

/** Read the login-shell PATH again and look for the worktree's Go. */
export async function refreshGoEnv(worktreePath: string): Promise<GoEnvResponse> {
  return fetchJson<GoEnvResponse>("/go-env/refresh", {
    method: "POST",
    body: JSON.stringify({ worktreePath }),
  });
}

export async function getGoToolchainCandidates(
  worktreePath: string,
): Promise<GoToolchainCandidatesResponse> {
  return fetchJson<GoToolchainCandidatesResponse>(
    withScope("/go-env/candidates", { wt: worktreePath }),
  );
}

/** Choose the worktree's Go, or return it to automatic detection with null. */
export async function setGoToolchainChoice(
  request: GoToolchainChoiceRequest,
): Promise<GoEnvResponse> {
  return fetchJson<GoEnvResponse>("/go-env/choice", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
