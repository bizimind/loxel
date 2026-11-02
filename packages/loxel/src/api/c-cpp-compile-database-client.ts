import type {
  CompileDatabaseChoiceRequest,
  CompileDatabaseFileRequest,
  CompileDatabaseFileResponse,
  CompileDatabaseStatus,
} from "./c-cpp-compile-database-model";
import { fetchJson, withScope } from "./client";

export async function getCompileDatabaseStatus(
  worktreePath: string,
): Promise<CompileDatabaseStatus> {
  return fetchJson<CompileDatabaseStatus>(withScope("/compile-database", { wt: worktreePath }));
}

/** The database clangd uses for one file, and what to run when there is none. */
export async function getFileCompileDatabase(
  request: CompileDatabaseFileRequest,
): Promise<CompileDatabaseFileResponse> {
  return fetchJson<CompileDatabaseFileResponse>("/compile-database/file", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/** Choose the worktree's database, or return it to automatic detection with null. */
export async function setCompileDatabaseChoice(
  request: CompileDatabaseChoiceRequest,
): Promise<CompileDatabaseStatus> {
  return fetchJson<CompileDatabaseStatus>("/compile-database/choice", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
