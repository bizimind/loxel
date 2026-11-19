import type {
  CompileDatabaseChoiceRequest,
  CompileDatabaseFileRequest,
  CompileDatabaseFileResponse,
  CompileDatabaseStatus,
} from "./c-cpp-compile-database-model";
import { withScope } from "./client";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getCompileDatabaseStatus(wt: WorktreeRef): Promise<CompileDatabaseStatus> {
  return connectionOf(wt.server).fetchJson<CompileDatabaseStatus>(
    withScope("/compile-database", { wt: wt.path }),
  );
}

/** The database clangd uses for one file, and what to run when there is none. */
export async function getFileCompileDatabase(
  wt: WorktreeRef,
  choice: Omit<CompileDatabaseFileRequest, "worktreePath">,
): Promise<CompileDatabaseFileResponse> {
  return connectionOf(wt.server).fetchJson<CompileDatabaseFileResponse>("/compile-database/file", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}

/** Choose the worktree's database, or return it to automatic detection with null. */
export async function setCompileDatabaseChoice(
  wt: WorktreeRef,
  choice: Omit<CompileDatabaseChoiceRequest, "worktreePath">,
): Promise<CompileDatabaseStatus> {
  return connectionOf(wt.server).fetchJson<CompileDatabaseStatus>("/compile-database/choice", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}
