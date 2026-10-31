import { fetchJson, withScope } from "./client";
import type {
  JavaEnvCandidatesResponse,
  JavaEnvResponse,
  JavaOverrideRequest,
} from "./java-env-model";

export async function getJavaEnv(worktreePath: string): Promise<JavaEnvResponse> {
  return fetchJson<JavaEnvResponse>(withScope("/java-env", { wt: worktreePath }));
}

export async function getJavaEnvCandidates(
  worktreePath: string,
): Promise<JavaEnvCandidatesResponse> {
  return fetchJson<JavaEnvCandidatesResponse>(
    withScope("/java-env/candidates", { wt: worktreePath }),
  );
}

/** Choose the worktree's JDK, or return it to automatic detection with null. */
export async function setJavaOverride(request: JavaOverrideRequest): Promise<JavaEnvResponse> {
  return fetchJson<JavaEnvResponse>("/java-env/override", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
