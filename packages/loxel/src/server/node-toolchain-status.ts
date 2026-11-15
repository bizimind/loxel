import { nodeToolchain } from "@/api/node-env-model";

import {
  getNodeEnv,
  listNodeEnvs,
  refreshAllNodeEnvs,
  refreshNodeEnv,
  subscribeNodeEnv,
} from "./node-env";
import { nodeOverrideStoreKey, onNodeOverrideChange, setNodeOverride } from "./node-override-store";
import { error, json } from "./response-helpers";
import type { ToolchainStatusModule } from "./toolchain-status-module";

// GET /api/node-env?wt= — The Node a worktree uses
async function handleNodeEnv(wtPath: string): Promise<Response> {
  return json(await getNodeEnv(wtPath));
}

// GET /api/node-env/candidates?wt= — The Node versions the user can choose for a worktree
async function handleNodeEnvCandidates(wtPath: string): Promise<Response> {
  return json(await listNodeEnvs(wtPath));
}

// POST /api/node-env/override — Choose a worktree's Node, or (null) return to detection
async function handleNodeOverride(
  wtPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { nodePath } = body;
  if (nodePath !== null && typeof nodePath !== "string") {
    return error("nodePath must be a string or null", 400);
  }
  if (nodePath !== null) {
    // Only what the picker offered, which has passed the checks a stored choice must keep passing.
    const { candidates } = await listNodeEnvs(wtPath);
    if (!candidates.some((candidate) => candidate.nodePath === nodePath)) {
      return error(`${nodePath} is not a Node installation Loxel found`, 400);
    }
  }
  setNodeOverride(wtPath, nodePath);
  return json(await getNodeEnv(wtPath));
}

export const nodeToolchainStatus: ToolchainStatusModule = {
  toolchain: nodeToolchain,
  subscribe: subscribeNodeEnv,
  refresh: refreshNodeEnv,
  refreshAll: refreshAllNodeEnvs,
  onOverrideChange: onNodeOverrideChange,
  overrideStoreKey: nodeOverrideStoreKey,
  routes: {
    GET: { "/api/node-env": handleNodeEnv, "/api/node-env/candidates": handleNodeEnvCandidates },
    POST: { "/api/node-env/override": handleNodeOverride },
  },
};
