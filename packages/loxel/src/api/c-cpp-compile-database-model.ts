import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** How clangd comes to use a database for a file. */
export type CompileDatabaseSource =
  /** Chosen for the worktree: passed to clangd, so it applies to every file. */
  | "chosen"
  /** The worktree's only one in a non-standard folder: passed to clangd, likewise. */
  | "automatic"
  /** clangd's own search, from the file's folder upward. */
  | "search"
  /** `CompileFlags.CompilationDatabase` in a `.clangd` file. */
  | "clangd-config";

/** `GET /api/compile-database?wt=` response: a worktree's databases, whichever file is open. */
export interface CompileDatabaseStatus {
  /** The folder chosen for the worktree, even when it no longer holds a database. */
  chosen: string | null;
  chosenUsable: boolean;
  /** The folder used without being chosen; null unless {@link candidates} has exactly one. */
  automatic: string | null;
  /** Folders under the worktree root holding a database clangd's own search does not reach. */
  candidates: string[];
  /** Where clangd's own search or a `.clangd` finds a database for some of the worktree's files. */
  foundByClangd: string[];
  /** The worktree was too large to search whole, so nothing is picked without being chosen. */
  searchCut: boolean;
}

/** `POST /api/compile-database/file` body: a file of the worktree. */
export interface CompileDatabaseFileRequest {
  worktreePath: string;
  filePath: string;
}

/** A `.clangd` file's part in a file having no database. */
export interface ClangdConfigEffect {
  /** The `.clangd` file. */
  path: string;
  /** `none`: it turns the database off. `missing`: it names a folder with none. `flags`: it adds compile flags. */
  effect: "none" | "missing" | "flags";
}

/** `POST /api/compile-database/file` response. */
export interface CompileDatabaseFileResponse {
  /** The database clangd uses for the file; null when it guesses the file's flags. */
  database: { path: string; source: CompileDatabaseSource } | null;
  clangdConfig: ClangdConfigEffect | null;
  /** What to run in a terminal to get a database; null when the file has one. Loxel runs nothing. */
  hint: string | null;
}

/** `POST /api/compile-database/choice` body; its response is a {@link CompileDatabaseStatus}. */
export interface CompileDatabaseChoiceRequest {
  worktreePath: string;
  /** A folder, or a database file in one; null returns the worktree to automatic detection. */
  path: string | null;
}

export const cCppToolchain = {
  id: "c-cpp",
  languageIds: ["c", "cpp", "objective-c", "objective-cpp"],
  changedMessage: "c_cpp_compile_database_changed",
  selectAction: { id: "cCpp.selectCompileDatabase", label: "C/C++: Select Compile Database" },
} as const satisfies ToolchainStatusDescriptor;
