import type { QueryOptions as LocalDbQueryOptions } from "@bizimind/localdb-sdk";

import type { ServerId, WorktreeRef } from "@/api/worktree-ref";
import { isWorktreeRef, sameWorktreeRef } from "@/api/worktree-ref";
import { isWithin } from "@/lib/project-file-helpers";
import type { DiffSource } from "@/store/worktree-repository";

declare const builtByQueryKeys: unique symbol;

/** A key {@link queryKeys} built, with the parts `T`. */
export type BuiltQueryKey<T extends readonly unknown[]> = T & { readonly [builtByQueryKeys]: true };

/** The prefix key a local database's data is cached under. */
export type LocalDbKey = BuiltQueryKey<readonly ["localdb", WorktreeRef | null]>;

/**
 * The only key type TanStack Query takes here (registered below): a raw array, or one spread from
 * a built key, fails typecheck, so every key names its server the way {@link queryKeys} does.
 */
export type LoxelQueryKey = BuiltQueryKey<readonly unknown[]>;

declare module "@tanstack/react-query" {
  interface Register {
    queryKey: LoxelQueryKey;
  }
}

/** The one place a key is made. */
function key<const T extends readonly unknown[]>(...parts: T): BuiltQueryKey<T> {
  return parts as BuiltQueryKey<T>;
}

/**
 * Every query's key. Data about a project or a worktree is keyed by its {@link WorktreeRef} (a
 * project's is its root's), which names the server; other server data by `{ server }`, so a key's
 * server is the `server` of whichever part has one ({@link keyServer}).
 * A project ref leads where there is one, so a project's repo-wide data (branches) is shared by
 * its worktrees and a prefix reaches all of the project's. Home's keys carry no ref, as Home has
 * no server. Prefix builders whose name ends in `All` reach every server's keys.
 */
export const queryKeys = {
  commits: (project: WorktreeRef | null, wt: WorktreeRef | null, preset: string) =>
    key("commits", project, wt, preset),
  /** Prefix key for the commit graphs of every worktree of `project`. */
  projectCommits: (project: WorktreeRef | null) => key("commits", project),
  /** Prefix key for every commit graph. */
  commitsAll: () => key("commits"),
  branchCommits: (project: WorktreeRef | null, wt: WorktreeRef | null) =>
    key("branchCommits", project, wt),
  /** Prefix key for the branch commits of every worktree of `project`. */
  projectBranchCommits: (project: WorktreeRef | null) => key("branchCommits", project),
  status: (project: WorktreeRef | null, wt: WorktreeRef | null) => key("status", project, wt),
  branches: (project: WorktreeRef | null) => key("branches", project),
  worktreeStatuses: (project: WorktreeRef | null) => key("worktreeStatuses", project),
  diff: (project: WorktreeRef | null, source: DiffSource | null) => key("diff", project, source),
  /** Prefix key for every diff. */
  diffAll: () => key("diff"),
  fileContent: (project: WorktreeRef | null, path: string, ref?: string, wt?: WorktreeRef) =>
    key("fileContent", project, path, ref, wt),
  /** Prefix key for invalidating all fileContent queries for a given file, regardless of ref/worktree. */
  fileContentPrefix: (project: WorktreeRef | null, path: string) =>
    key("fileContent", project, path),
  /** `.editorconfig` properties of an open file; invalidated when an `.editorconfig` changes. */
  editorConfig: (path: string, wt?: WorktreeRef) => key("editorConfig", path, wt),
  /** Prefix key matching a file's `editorConfig` queries for every worktree. */
  editorConfigPrefix: (path: string) => key("editorConfig", path),
  diagnostics: (
    project: WorktreeRef | null,
    ref: string | undefined,
    wt: WorktreeRef | undefined,
  ) => key("diagnostics", project, ref, wt),
  dirContents: (project: WorktreeRef | null, dir: string) => key("dirContents", project, dir),
  detachedFiles: (project: WorktreeRef | null, wt: WorktreeRef | null) =>
    key("detachedFiles", project, wt),
  externalFiles: (project: WorktreeRef | null, wt: WorktreeRef | null) =>
    key("externalFiles", project, wt),
  toolchainStatus: (toolchainId: string, project: WorktreeRef | null, wt: WorktreeRef | null) =>
    key("toolchainStatus", project, wt, toolchainId),
  /** One file's answer from a toolchain; under its status's key, so whatever refreshes that refreshes this. */
  toolchainFileStatus: (
    toolchainId: string,
    project: WorktreeRef | null,
    wt: WorktreeRef | null,
    filePath: string | null,
  ) => key("toolchainStatus", project, wt, toolchainId, filePath),
  /** Prefix key for every worktree's status of every language toolchain. */
  toolchainStatusAll: () => key("toolchainStatus"),
  repoTrust: (project: WorktreeRef | null, wt: WorktreeRef | null) => key("repoTrust", project, wt),
  /** Every repository's answer, for Settings > Security; under {@link repoTrustAll}. */
  repoTrustList: (server: ServerId) => key("repoTrust", "list", { server }),
  /** Prefix key for every worktree's repository trust, and the list of every repository's. */
  repoTrustAll: () => key("repoTrust"),
  /** `GET /api/terminals`; invalidated by `terminals_changed`. */
  runningTerminals: (server: ServerId) => key("runningTerminals", { server }),
  /** The app update's state, which Electron main keeps, not a server. */
  updateStatus: () => key("updateStatus"),
  version: (server: ServerId) => key("version", { server }),
  openInApps: (server: ServerId, path: string) => key("openInApps", { server }, path),
  pathExists: (server: ServerId, path: string) => key("pathExists", { server }, path),
  /** Prefix key for all of `project`'s local database: its tables, schemas, views and rows. */
  localdb: (project: WorktreeRef | null): LocalDbKey => key("localdb", project),
  localdbTables: (project: WorktreeRef | null) => key("localdb", project, "tables"),
  localdbSchema: (project: WorktreeRef | null, tableName: string | null) =>
    key("localdb", project, "schema", tableName),
  localdbViews: (project: WorktreeRef | null, tableId: number | undefined) =>
    key("localdb", project, "views", tableId),
  /** Prefix key for every page of a table's rows, under a data adapter's {@link localdb} key. */
  localdbRows: (adapterKey: LocalDbKey, tableName: string) =>
    key(adapterKey[0], adapterKey[1], "rows", tableName),
  localdbRowsPage: (adapterKey: LocalDbKey, tableName: string, options: LocalDbQueryOptions) =>
    key(adapterKey[0], adapterKey[1], "rows", tableName, options),
};

/** Whether a key's part is `ref`: an equal ref, or null for none. */
function isRefPart(part: unknown, ref: WorktreeRef | null): boolean {
  if (ref === null) return part === null;
  return isWorktreeRef(part) && sameWorktreeRef(part, ref);
}

const WORKING_TREE_DIFF_TYPES: ReadonlySet<unknown> = new Set<DiffSource["type"]>([
  "staged",
  "unstaged",
  "uncommitted",
]);

/**
 * Whether a query key is a diff of `project` whose content follows the working tree or the
 * index, of the worktree `wt` when given. Commit and range diffs are keyed by full SHAs, so
 * their content never changes and a status or ref change has no reason to refetch them.
 */
export function isWorkingTreeDiffKey(
  queryKey: readonly unknown[],
  project: WorktreeRef | null,
  wt?: WorktreeRef,
): boolean {
  if (queryKey[0] !== "diff" || !isRefPart(queryKey[1], project)) return false;
  const source = queryKey[2];
  return (
    typeof source === "object" &&
    source !== null &&
    "type" in source &&
    WORKING_TREE_DIFF_TYPES.has(source.type) &&
    // A diff source names its worktree by path; the project ref above pins the server.
    (wt === undefined || ("worktree" in source && source.worktree === wt.path))
  );
}

/** Whether a query key is the listing of `dir` or a directory below it, in `project`. */
export function isDirContentsKeyBelow(
  queryKey: readonly unknown[],
  project: WorktreeRef | null,
  dir: string,
): boolean {
  if (queryKey[0] !== "dirContents" || !isRefPart(queryKey[1], project)) return false;
  const listed = queryKey[2];
  return typeof listed === "string" && isWithin(listed, dir);
}

/** Whether a query key is the `.editorconfig` properties of a file under `dir` (ending in `/`; "" for all). */
export function isEditorConfigKeyBelow(queryKey: readonly unknown[], dir: string): boolean {
  return (
    queryKey[0] === "editorConfig" && typeof queryKey[1] === "string" && queryKey[1].startsWith(dir)
  );
}

export function isFileContentKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "fileContent";
}

/** Whether a query key is a file of `wt` as on disk (no ref), as editors and the diff view read it. */
export function isWorktreeDiskContentKey(
  queryKey: readonly unknown[],
  project: WorktreeRef | null,
  wt: WorktreeRef,
): boolean {
  return (
    queryKey[0] === "fileContent" &&
    isRefPart(queryKey[1], project) &&
    queryKey[3] === undefined &&
    isRefPart(queryKey[4], wt)
  );
}

/** The server a key's data comes from: the `server` of its ref or `{ server }` part. */
export function keyServer(queryKey: readonly unknown[]): ServerId | null {
  for (const part of queryKey) {
    if (typeof part === "object" && part !== null && "server" in part) {
      // Only refs and `{ server }` parts have a `server`, typed `ServerId` by the builders above.
      return typeof part.server === "string" ? (part.server as ServerId) : null;
    }
  }
  return null;
}

/**
 * Whether a query key reaches into `wt`: a key of `wt`'s server that names `wt`, a worktree or
 * project inside it, or a path inside it (a listed directory, a file). A key naming no server
 * (Home's, or one built before its project was known) is the window's own: it counts as
 * `homeServer`'s.
 */
export function isKeyWithinWorktree(
  queryKey: readonly unknown[],
  wt: WorktreeRef,
  homeServer: ServerId,
): boolean {
  if ((keyServer(queryKey) ?? homeServer) !== wt.server) return false;
  return queryKey.some((part) =>
    isWorktreeRef(part)
      ? isWithin(part.path, wt.path)
      : typeof part === "string" && isWithin(part, wt.path),
  );
}

/**
 * The key under which the diff view caches the working-tree side of an uncommitted diff: the
 * worktree-relative path with no ref. File change events carry absolute paths, so they never
 * match this key on their own. Null when the path is not inside the worktree (detached or
 * external files), which the diff view never reads.
 */
export function workingTreeFileContentKey(
  project: WorktreeRef | null,
  wt: WorktreeRef,
  absPath: string,
): ReturnType<typeof queryKeys.fileContent> | null {
  const root = wt.path.endsWith("/") ? wt.path : `${wt.path}/`;
  if (!absPath.startsWith(root) || absPath.length === root.length) return null;
  return queryKeys.fileContent(project, absPath.slice(root.length), undefined, wt);
}
