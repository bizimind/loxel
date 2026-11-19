import { withScope } from "./client";
import type {
  NodeEnvCandidatesResponse,
  NodeEnvResponse,
  NodeOverrideRequest,
} from "./node-env-model";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getNodeEnv(wt: WorktreeRef): Promise<NodeEnvResponse> {
  return connectionOf(wt.server).fetchJson<NodeEnvResponse>(
    withScope("/node-env", { wt: wt.path }),
  );
}

export async function getNodeEnvCandidates(wt: WorktreeRef): Promise<NodeEnvCandidatesResponse> {
  return connectionOf(wt.server).fetchJson<NodeEnvCandidatesResponse>(
    withScope("/node-env/candidates", { wt: wt.path }),
  );
}

/** Choose the worktree's Node, or return it to automatic detection with null. */
export async function setNodeOverride(
  wt: WorktreeRef,
  choice: Omit<NodeOverrideRequest, "worktreePath">,
): Promise<NodeEnvResponse> {
  return connectionOf(wt.server).fetchJson<NodeEnvResponse>("/node-env/override", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}
