import { fetchJson, withScope } from "./client";
import type { GoEnvResponse } from "./go-env-model";

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
