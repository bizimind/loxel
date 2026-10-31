import { fetchJson, withScope } from "./client";
import type {
  NodeEnvCandidatesResponse,
  NodeEnvResponse,
  NodeOverrideRequest,
} from "./node-env-model";

export async function getNodeEnv(worktreePath: string): Promise<NodeEnvResponse> {
  return fetchJson<NodeEnvResponse>(withScope("/node-env", { wt: worktreePath }));
}

export async function getNodeEnvCandidates(
  worktreePath: string,
): Promise<NodeEnvCandidatesResponse> {
  return fetchJson<NodeEnvCandidatesResponse>(
    withScope("/node-env/candidates", { wt: worktreePath }),
  );
}

/** Choose the worktree's Node, or return it to automatic detection with null. */
export async function setNodeOverride(request: NodeOverrideRequest): Promise<NodeEnvResponse> {
  return fetchJson<NodeEnvResponse>("/node-env/override", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
