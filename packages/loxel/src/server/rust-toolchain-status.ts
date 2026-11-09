import {
  type RustToolchainCandidatesResponse,
  type RustToolchainResponse,
  rustToolchain,
} from "@/api/rust-toolchain-model";

import { error, json } from "./response-helpers";
import {
  getRustToolchain,
  listRustToolchains,
  refreshAllRustToolchains,
  refreshRustToolchain,
  resolveRustToolchain,
  subscribeRustToolchain,
} from "./rust-toolchain";
import {
  getRustChoice,
  onRustChoiceChange,
  rustChoiceStoreKey,
  setRustChoice,
} from "./rust-toolchain-store";
import type { ToolchainStatusModule } from "./toolchain-status-module";

async function rustToolchainResponse(wtPath: string): Promise<RustToolchainResponse> {
  return { toolchain: await getRustToolchain(wtPath), chosen: getRustChoice(wtPath) };
}

// GET /api/rust-toolchain?wt= — The toolchain Loxel uses for a worktree
async function handleRustToolchain(wtPath: string): Promise<Response> {
  return json(await rustToolchainResponse(wtPath));
}

// GET /api/rust-toolchain/candidates?wt= — Toolchains the user can choose for a worktree
async function handleRustToolchainCandidates(wtPath: string): Promise<Response> {
  const [candidates, automatic] = await Promise.all([
    listRustToolchains(wtPath),
    resolveRustToolchain(wtPath, { chosen: null }),
  ]);
  const response: RustToolchainCandidatesResponse = {
    candidates,
    automatic,
    chosen: getRustChoice(wtPath),
  };
  return json(response);
}

// POST /api/rust-toolchain/choice — Choose a worktree's toolchain, or (null) return to detection
async function handleRustToolchainChoice(
  wtPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { toolchain } = body;
  if (toolchain !== null && typeof toolchain !== "string") {
    return error("toolchain must be a string or null", 400);
  }
  if (toolchain !== null) {
    const installed = await listRustToolchains(wtPath);
    if (!installed.some((choice) => choice.name === toolchain)) {
      return error(`${toolchain} is not an installed Rust toolchain Loxel can use`, 400);
    }
  }
  setRustChoice(wtPath, toolchain);
  return json(await rustToolchainResponse(wtPath));
}

export const rustToolchainStatus: ToolchainStatusModule = {
  toolchain: rustToolchain,
  subscribe: subscribeRustToolchain,
  refresh: refreshRustToolchain,
  refreshAll: refreshAllRustToolchains,
  onOverrideChange: onRustChoiceChange,
  overrideStoreKey: rustChoiceStoreKey,
  routes: {
    GET: {
      "/api/rust-toolchain": handleRustToolchain,
      "/api/rust-toolchain/candidates": handleRustToolchainCandidates,
    },
    POST: { "/api/rust-toolchain/choice": handleRustToolchainChoice },
  },
};
