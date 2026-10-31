import {
  type PythonEnv,
  type PythonEnvCandidatesResponse,
  type PythonEnvResponse,
  type PythonInterpreter,
  pythonToolchain,
} from "@/api/python-env-model";

import {
  getPythonEnv,
  listPythonEnvs,
  normalizePythonOverride,
  refreshAllPythonEnvs,
  refreshPythonEnv,
  subscribePythonEnv,
} from "./python-env";
import {
  getPythonOverride,
  onPythonOverrideChange,
  pythonOverrideStoreKey,
  setPythonOverride,
} from "./python-override-store";
import { pythonVersion } from "./python-version";
import { error, json } from "./response-helpers";
import type { ToolchainStatusModule } from "./toolchain-status-module";

async function withVersion(env: PythonEnv, wtPath: string): Promise<PythonInterpreter> {
  return { ...env, version: await pythonVersion(env.pythonPath, wtPath) };
}

async function pythonEnvResponse(wtPath: string): Promise<PythonEnvResponse> {
  const env = await getPythonEnv(wtPath);
  return { env: env && (await withVersion(env, wtPath)), overridePath: getPythonOverride(wtPath) };
}

// GET /api/python-env?wt= — The Python interpreter Loxel uses for a worktree
async function handlePythonEnv(wtPath: string): Promise<Response> {
  return json(await pythonEnvResponse(wtPath));
}

// GET /api/python-env/candidates?wt= — Interpreters the user can choose for a worktree
async function handlePythonEnvCandidates(wtPath: string): Promise<Response> {
  const { candidates, automatic } = await listPythonEnvs(wtPath);
  const response: PythonEnvCandidatesResponse = {
    candidates: await Promise.all(candidates.map((env) => withVersion(env, wtPath))),
    automaticPath: automatic?.pythonPath ?? null,
    overridePath: getPythonOverride(wtPath),
  };
  return json(response);
}

// POST /api/python-env/override — Choose a worktree's interpreter, or (null) return to detection
async function handlePythonOverride(
  wtPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { pythonPath } = body;
  if (pythonPath !== null && typeof pythonPath !== "string") {
    return error("pythonPath must be a string or null", 400);
  }
  let chosen: string | null = null;
  if (pythonPath !== null) {
    try {
      chosen = await normalizePythonOverride(wtPath, pythonPath);
    } catch (err) {
      return error(err instanceof Error ? err.message : "Invalid Python interpreter", 400);
    }
    // Language servers and terminals will run it, so take only what answers like a Python.
    if (!(await pythonVersion(chosen, wtPath))) {
      return error(`${chosen} did not report a Python version; is it a Python interpreter?`, 400);
    }
  }
  setPythonOverride(wtPath, chosen);
  return json(await pythonEnvResponse(wtPath));
}

export const pythonToolchainStatus: ToolchainStatusModule = {
  toolchain: pythonToolchain,
  subscribe: subscribePythonEnv,
  refresh: refreshPythonEnv,
  refreshAll: refreshAllPythonEnvs,
  onOverrideChange: onPythonOverrideChange,
  overrideStoreKey: pythonOverrideStoreKey,
  routes: {
    GET: {
      "/api/python-env": handlePythonEnv,
      "/api/python-env/candidates": handlePythonEnvCandidates,
    },
    POST: { "/api/python-env/override": handlePythonOverride },
  },
};
