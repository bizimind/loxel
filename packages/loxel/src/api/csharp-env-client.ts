import { withScope } from "./client";
import type {
  CSharpSolutionRequest,
  CSharpSolutionsResponse,
  CSharpStatusResponse,
} from "./csharp-env-model";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getCSharpStatus(wt: WorktreeRef): Promise<CSharpStatusResponse> {
  return connectionOf(wt.server).fetchJson<CSharpStatusResponse>(
    withScope("/csharp-status", { wt: wt.path }),
  );
}

export async function getCSharpSolutions(wt: WorktreeRef): Promise<CSharpSolutionsResponse> {
  return connectionOf(wt.server).fetchJson<CSharpSolutionsResponse>(
    withScope("/csharp-status/solutions", { wt: wt.path }),
  );
}

/** Choose the worktree's solution, or return it to automatic detection with null. */
export async function setCSharpSolution(
  wt: WorktreeRef,
  choice: Omit<CSharpSolutionRequest, "worktreePath">,
): Promise<CSharpStatusResponse> {
  return connectionOf(wt.server).fetchJson<CSharpStatusResponse>("/csharp-status/solution", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}
