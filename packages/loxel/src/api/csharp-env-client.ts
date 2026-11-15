import { fetchJson, withScope } from "./client";
import type {
  CSharpSolutionRequest,
  CSharpSolutionsResponse,
  CSharpStatusResponse,
} from "./csharp-env-model";

export async function getCSharpStatus(worktreePath: string): Promise<CSharpStatusResponse> {
  return fetchJson<CSharpStatusResponse>(withScope("/csharp-status", { wt: worktreePath }));
}

export async function getCSharpSolutions(worktreePath: string): Promise<CSharpSolutionsResponse> {
  return fetchJson<CSharpSolutionsResponse>(
    withScope("/csharp-status/solutions", { wt: worktreePath }),
  );
}

/** Choose the worktree's solution, or return it to automatic detection with null. */
export async function setCSharpSolution(
  request: CSharpSolutionRequest,
): Promise<CSharpStatusResponse> {
  return fetchJson<CSharpStatusResponse>("/csharp-status/solution", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
