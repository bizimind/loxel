import path from "node:path";

import { cCppToolchain } from "@/api/c-cpp-compile-database-model";

import {
  normalizeCompileDatabaseChoice,
  refreshCompileDatabases,
  resolveCompileDatabases,
  resolveFileCompileDatabase,
  subscribeCompileDatabases,
} from "./compile-database";
import {
  compileDatabaseStoreKey,
  onCompileDatabaseChoiceChange,
  setCompileDatabaseChoice,
} from "./compile-database-store";
import { error, json } from "./response-helpers";
import type { ToolchainStatusModule } from "./toolchain-status-module";

// GET /api/compile-database?wt= — A worktree's compile databases, whichever file is open
async function handleStatus(wtPath: string): Promise<Response> {
  return json(await resolveCompileDatabases(wtPath));
}

// POST /api/compile-database/file — The database clangd uses for one file
async function handleFile(wtPath: string, body: Record<string, unknown>): Promise<Response> {
  const { filePath } = body;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    return error("filePath must be an absolute path", 400);
  }
  return json(await resolveFileCompileDatabase(wtPath, filePath));
}

// POST /api/compile-database/choice — Choose a worktree's database, or (null) return to detection
async function handleChoice(wtPath: string, body: Record<string, unknown>): Promise<Response> {
  const { path: chosen } = body;
  if (chosen !== null && typeof chosen !== "string") {
    return error("path must be a string or null", 400);
  }
  try {
    setCompileDatabaseChoice(
      wtPath,
      chosen === null ? null : await normalizeCompileDatabaseChoice(wtPath, chosen),
    );
  } catch (err) {
    return error(err instanceof Error ? err.message : "Invalid compile database", 400);
  }
  return json(await resolveCompileDatabases(wtPath));
}

export const cCppToolchainStatus: ToolchainStatusModule = {
  toolchain: cCppToolchain,
  subscribe: subscribeCompileDatabases,
  refresh: refreshCompileDatabases,
  // It reads the disk and the stored choice, no variable of the login shell.
  refreshAll: () => {},
  onOverrideChange: onCompileDatabaseChoiceChange,
  overrideStoreKey: compileDatabaseStoreKey,
  routes: {
    GET: { "/api/compile-database": handleStatus },
    POST: {
      "/api/compile-database/file": handleFile,
      "/api/compile-database/choice": handleChoice,
    },
  },
};
