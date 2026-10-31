import { fetchJson, withScope } from "./client";
import type {
  PythonEnvCandidatesResponse,
  PythonEnvResponse,
  PythonOverrideRequest,
} from "./python-env-model";

export async function getPythonEnv(worktreePath: string): Promise<PythonEnvResponse> {
  return fetchJson<PythonEnvResponse>(withScope("/python-env", { wt: worktreePath }));
}

export async function getPythonEnvCandidates(
  worktreePath: string,
): Promise<PythonEnvCandidatesResponse> {
  return fetchJson<PythonEnvCandidatesResponse>(
    withScope("/python-env/candidates", { wt: worktreePath }),
  );
}

/** Choose the worktree's interpreter, or return it to automatic detection with null. */
export async function setPythonOverride(
  request: PythonOverrideRequest,
): Promise<PythonEnvResponse> {
  return fetchJson<PythonEnvResponse>("/python-env/override", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
