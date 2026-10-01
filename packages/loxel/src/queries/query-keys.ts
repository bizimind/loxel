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

const WORKING_TREE_DIFF_TYPES: ReadonlySet<unknown> = new Set<DiffSource["type"]>([
  "staged",
  "unstaged",
  "uncommitted",
]);

/**
 * Whether a query key is a diff of `projectPath` whose content follows the working tree or the
 * index. Commit and range diffs are keyed by full SHAs, so their content never changes and a
 * status or ref change has no reason to refetch them.
 */
export function isWorkingTreeDiffKey(
  queryKey: readonly unknown[],
  projectPath: string | null,
): boolean {
  if (queryKey[0] !== "diff" || queryKey[1] !== projectPath) return false;
  const source = queryKey[2];
  return (
    typeof source === "object" &&
    source !== null &&
    "type" in source &&
    WORKING_TREE_DIFF_TYPES.has(source.type)
  );
}

/**
 * The key under which the diff view caches the working-tree side of an uncommitted diff: the
 * worktree-relative path with no ref. File change events carry absolute paths, so they never
 * match this key on their own. Null when the path is not inside the worktree (detached or
 * external files), which the diff view never reads.
 */
export function workingTreeFileContentKey(
  projectPath: string | null,
  wtPath: string,
  absPath: string,
): ReturnType<typeof queryKeys.fileContent> | null {
  const root = wtPath.endsWith("/") ? wtPath : `${wtPath}/`;
  if (!absPath.startsWith(root) || absPath.length === root.length) return null;
  return queryKeys.fileContent(projectPath, absPath.slice(root.length), undefined, wtPath);
}
