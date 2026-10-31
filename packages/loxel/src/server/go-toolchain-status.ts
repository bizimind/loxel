import path from "node:path";

import { type GoEnvResponse, goToolchain } from "@/api/go-env-model";

import { getGoEnv, refreshAllGoEnvs, refreshGoEnv, subscribeGoEnv } from "./go-env";
import { json } from "./response-helpers";
import { resolveLoginShellEnv } from "./shell-env";
import type { ToolchainStatusModule } from "./toolchain-status-module";

async function goEnvResponse(wtPath: string): Promise<Response> {
  const response: GoEnvResponse = { env: await getGoEnv(wtPath) };
  return json(response);
}

// POST /api/go-env/refresh — Look for Go again, on a PATH read again from the login shell
async function handleGoEnvRefresh(wtPath: string): Promise<Response> {
  // Not the throttled refresh: the user asked, perhaps right after a language server's start read it.
  await resolveLoginShellEnv();
  refreshGoEnv(wtPath);
  return goEnvResponse(wtPath);
}

export const goToolchainStatus: ToolchainStatusModule = {
  toolchain: goToolchain,
  subscribe: subscribeGoEnv,
  refresh: refreshGoEnv,
  refreshAll: refreshAllGoEnvs,
  // Go has no per-worktree choice to store.
  onOverrideChange: () => () => undefined,
  overrideStoreKey: (wtPath) => `go-toolchain:${path.resolve(wtPath)}`,
  routes: {
    // GET /api/go-env?wt= — The Go toolchain Loxel uses for a worktree
    GET: { "/api/go-env": goEnvResponse },
    POST: { "/api/go-env/refresh": handleGoEnvRefresh },
  },
};
