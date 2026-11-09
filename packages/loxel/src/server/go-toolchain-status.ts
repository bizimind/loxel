import {
  type GoEnvResponse,
  type GoToolchainCandidatesResponse,
  goToolchain,
} from "@/api/go-env-model";

import { automaticGoEnv, getGoEnv, refreshAllGoEnvs, refreshGoEnv, subscribeGoEnv } from "./go-env";
import { listGoToolchains, normalizeGoChoice } from "./go-toolchain-candidates";
import { getGoChoice, goChoiceStoreKey, onGoChoiceChange, setGoChoice } from "./go-toolchain-store";
import { error, json } from "./response-helpers";
import { resolveLoginShellEnv } from "./shell-env";
import type { ToolchainStatusModule } from "./toolchain-status-module";

async function goEnvResponse(wtPath: string): Promise<Response> {
  const response: GoEnvResponse = { env: await getGoEnv(wtPath), chosen: getGoChoice(wtPath) };
  return json(response);
}

// POST /api/go-env/refresh — Look for Go again, on a PATH read again from the login shell
async function handleGoEnvRefresh(wtPath: string): Promise<Response> {
  // Not the throttled refresh: the user asked, perhaps right after a language server's start read it.
  await resolveLoginShellEnv();
  refreshGoEnv(wtPath);
  return goEnvResponse(wtPath);
}

// GET /api/go-env/candidates?wt= — What the user can choose for a worktree
async function handleGoEnvCandidates(wtPath: string): Promise<Response> {
  const automatic = await automaticGoEnv(wtPath);
  const candidates = await listGoToolchains(wtPath, automatic ?? (await getGoEnv(wtPath)));
  const response: GoToolchainCandidatesResponse = {
    candidates,
    automatic,
    chosen: getGoChoice(wtPath),
  };
  return json(response);
}

// POST /api/go-env/choice — Choose a worktree's Go, or (null) return to detection
async function handleGoEnvChoice(wtPath: string, body: Record<string, unknown>): Promise<Response> {
  const { goPath } = body;
  if (goPath !== null && typeof goPath !== "string") {
    return error("goPath must be a string or null", 400);
  }
  try {
    setGoChoice(wtPath, goPath === null ? null : await normalizeGoChoice(wtPath, goPath));
  } catch (err) {
    return error(err instanceof Error ? err.message : "Invalid Go toolchain", 400);
  }
  return goEnvResponse(wtPath);
}

export const goToolchainStatus: ToolchainStatusModule = {
  toolchain: goToolchain,
  subscribe: subscribeGoEnv,
  refresh: refreshGoEnv,
  refreshAll: refreshAllGoEnvs,
  onOverrideChange: onGoChoiceChange,
  overrideStoreKey: goChoiceStoreKey,
  routes: {
    GET: { "/api/go-env": goEnvResponse, "/api/go-env/candidates": handleGoEnvCandidates },
    POST: { "/api/go-env/refresh": handleGoEnvRefresh, "/api/go-env/choice": handleGoEnvChoice },
  },
};
