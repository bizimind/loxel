import { withScope } from "./client";
import type {
  JavaEnvCandidatesResponse,
  JavaEnvResponse,
  JavaOverrideRequest,
  JavaReloadProjectsRequest,
} from "./java-env-model";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getJavaEnv(wt: WorktreeRef): Promise<JavaEnvResponse> {
  return connectionOf(wt.server).fetchJson<JavaEnvResponse>(
    withScope("/java-env", { wt: wt.path }),
  );
}

export async function getJavaEnvCandidates(wt: WorktreeRef): Promise<JavaEnvCandidatesResponse> {
  return connectionOf(wt.server).fetchJson<JavaEnvCandidatesResponse>(
    withScope("/java-env/candidates", { wt: wt.path }),
  );
}

/** Choose the worktree's JDK, or return it to automatic detection with null. */
export async function setJavaOverride(
  wt: WorktreeRef,
  choice: Omit<JavaOverrideRequest, "worktreePath">,
): Promise<JavaEnvResponse> {
  return connectionOf(wt.server).fetchJson<JavaEnvResponse>("/java-env/override", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}

/** Load the worktree's Maven and Gradle projects again. */
export async function reloadJavaProjects(wt: WorktreeRef): Promise<void> {
  const request: JavaReloadProjectsRequest = { worktreePath: wt.path };
  await connectionOf(wt.server).fetchJson("/java-env/reload-projects", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
