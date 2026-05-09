import type { DiffSource } from "@/store/worktree-repository";

export const queryKeys = {
  commits: (projectPath: string | null, wtPath: string | null, preset: string) =>
    ["commits", projectPath, wtPath, preset] as const,
  branchCommits: (projectPath: string | null, wtPath: string | null) =>
    ["branchCommits", projectPath, wtPath] as const,
  status: (projectPath: string | null, wtPath: string | null) =>
    ["status", projectPath, wtPath] as const,
  refs: (projectPath: string | null) => ["refs", projectPath] as const,
  branches: (projectPath: string | null) => ["branches", projectPath] as const,
  worktreeStatuses: (projectPath: string | null) => ["worktreeStatuses", projectPath] as const,
  diff: (projectPath: string | null, source: DiffSource | null) =>
    ["diff", projectPath, source] as const,
  projects: () => ["projects"] as const,
  currentProject: () => ["currentProject"] as const,
  worktrees: (projectPath: string | null) => ["worktrees", projectPath] as const,
  reviews: (projectPath: string | null) => ["reviews", projectPath] as const,
  placedThreads: (projectPath: string | null, reviewIds: string[], files: unknown[]) =>
    ["placedThreads", projectPath, reviewIds, files] as const,
  fileContent: (projectPath: string | null, path: string, ref?: string, worktree?: string) =>
    ["fileContent", projectPath, path, ref, worktree] as const,
  /** Prefix key for invalidating all fileContent queries for a given file, regardless of ref/worktree. */
  fileContentPrefix: (projectPath: string | null, path: string) =>
    ["fileContent", projectPath, path] as const,
  diagnostics: (
    projectPath: string | null,
    ref: string | undefined,
    worktree: string | undefined,
  ) => ["diagnostics", projectPath, ref, worktree] as const,
  dirContents: (projectPath: string | null, dir: string) =>
    ["dirContents", projectPath, dir] as const,
  detachedFiles: (projectPath: string | null, wtPath: string | null) =>
    ["detachedFiles", projectPath, wtPath] as const,
  externalFiles: (projectPath: string | null, wtPath: string | null) =>
    ["externalFiles", projectPath, wtPath] as const,
  updateStatus: () => ["updateStatus"] as const,
  version: () => ["version"] as const,
};
