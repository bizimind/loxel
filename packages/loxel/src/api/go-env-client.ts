import { withScope } from "./client";
import type {
  GoEnvResponse,
  GoToolchainCandidatesResponse,
  GoToolchainChoiceRequest,
} from "./go-env-model";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getGoEnv(wt: WorktreeRef): Promise<GoEnvResponse> {
  return connectionOf(wt.server).fetchJson<GoEnvResponse>(withScope("/go-env", { wt: wt.path }));
}

/** Read the login-shell PATH again and look for the worktree's Go. */
export async function refreshGoEnv(wt: WorktreeRef): Promise<GoEnvResponse> {
  return connectionOf(wt.server).fetchJson<GoEnvResponse>("/go-env/refresh", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path }),
  });
}

export async function getGoToolchainCandidates(
  wt: WorktreeRef,
): Promise<GoToolchainCandidatesResponse> {
  return connectionOf(wt.server).fetchJson<GoToolchainCandidatesResponse>(
    withScope("/go-env/candidates", { wt: wt.path }),
  );
}

/** Choose the worktree's Go, or return it to automatic detection with null. */
export async function setGoToolchainChoice(
  wt: WorktreeRef,
  choice: Omit<GoToolchainChoiceRequest, "worktreePath">,
): Promise<GoEnvResponse> {
  return connectionOf(wt.server).fetchJson<GoEnvResponse>("/go-env/choice", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}
