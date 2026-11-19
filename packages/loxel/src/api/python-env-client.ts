import { withScope } from "./client";
import type {
  PythonEnvCandidatesResponse,
  PythonEnvResponse,
  PythonOverrideRequest,
} from "./python-env-model";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getPythonEnv(wt: WorktreeRef): Promise<PythonEnvResponse> {
  return connectionOf(wt.server).fetchJson<PythonEnvResponse>(
    withScope("/python-env", { wt: wt.path }),
  );
}

export async function getPythonEnvCandidates(
  wt: WorktreeRef,
): Promise<PythonEnvCandidatesResponse> {
  return connectionOf(wt.server).fetchJson<PythonEnvCandidatesResponse>(
    withScope("/python-env/candidates", { wt: wt.path }),
  );
}

/** Choose the worktree's interpreter, or return it to automatic detection with null. */
export async function setPythonOverride(
  wt: WorktreeRef,
  choice: Omit<PythonOverrideRequest, "worktreePath">,
): Promise<PythonEnvResponse> {
  return connectionOf(wt.server).fetchJson<PythonEnvResponse>("/python-env/override", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}
