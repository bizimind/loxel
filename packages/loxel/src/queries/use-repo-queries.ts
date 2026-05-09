import type { UseQueryResult } from "@tanstack/react-query";

import { useQuery } from "@tanstack/react-query";

import type { DiffInfo } from "@/api/diff-model";
import type {
  BranchInfo,
  CommitInfo,
  GraphData,
  RefInfo,
  StatusInfo,
  WorktreeStatusInfo,
} from "@/api/git-models";
import type { DiffSource } from "@/store/worktree-repository";
import type { BranchFilterPreset } from "@/store/worktree-ui";

import * as api from "@/api/client";
import { toAbsoluteDir } from "@/lib/detached-path";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";

function getRecentDays(preset: BranchFilterPreset): number | null {
  switch (preset) {
    case "recent-1d":
      return 1;
    case "recent-2d":
      return 2;
    case "recent-3d":
      return 3;
    case "recent-5d":
      return 5;
    case "all":
    case "current-and-main":
      return null;
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown BranchFilterPreset: ${String(_exhaustive)}`);
    }
  }
}

async function fetchCommits(wt: string, preset: BranchFilterPreset, limit = 200) {
  const recentDays = getRecentDays(preset);

  let branches: string[] | undefined;
  if (recentDays !== null) {
    branches = await api.getRecentBranchNames(wt, recentDays);
    if (branches.length === 0) {
      return { commits: [] as CommitInfo[], refs: [] as RefInfo[] };
    }
  }

  return api.getGraph(wt, {
    limit,
    all: preset === "all" || preset === "current-and-main",
    branches,
  });
}

async function fetchDiff(wt: string, source: DiffSource | null): Promise<DiffInfo> {
  if (!source) return { files: [] };

  if (source.type === "uncommitted" && source.worktree) {
    return api.getDiff(wt, { worktree: source.worktree, base: source.base });
  }
  if (source.type === "staged") {
    return api.getDiff(wt, { staged: true });
  }
  if (source.type === "unstaged") {
    return api.getDiff(wt, { staged: false });
  }
  if (source.type === "commit" && source.commit) {
    return api.getDiff(wt, { commit: source.commit });
  }
  if (source.type === "range" && source.range) {
    return api.getDiff(wt, { range: source.range });
  }
  return { files: [] };
}

export type CommitsQueryData = GraphData;
export type StatusQueryData = StatusInfo;
export type BranchesQueryData = BranchInfo[];
export type WorktreeStatusesQueryData = WorktreeStatusInfo[];
export type DiffQueryData = DiffInfo;

// ---------------------------------------------------------------------------
// Scoped query factory — injects active project/worktree scope into every query.
// ---------------------------------------------------------------------------

function useScopedQuery<TData>(opts: {
  queryKey: (pp: string | null, wt: string | null) => readonly unknown[];
  queryFn: (wt: string, signal: AbortSignal) => Promise<TData>;
  extraEnabled?: boolean;
  staleTime?: number;
}): UseQueryResult<TData> {
  const { activeProjectPath, activeWorktreePath } = useQueryScope();
  return useQuery({
    queryKey: opts.queryKey(activeProjectPath, activeWorktreePath),
    queryFn: ({ signal }) => opts.queryFn(activeWorktreePath!, signal),
    enabled: activeProjectPath !== null && (opts.extraEnabled ?? true),
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
  });
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useCommitsQuery(preset: BranchFilterPreset, limit = 200) {
  return useScopedQuery({
    queryKey: (pp, wt) => queryKeys.commits(pp, wt, preset),
    queryFn: (wt) => fetchCommits(wt, preset, limit),
  });
}

export function useBranchCommitsQuery() {
  return useScopedQuery({
    queryKey: (pp, wt) => queryKeys.branchCommits(pp, wt),
    queryFn: (wt) => api.getBranchCommits(wt),
  });
}

export function useStatusQuery() {
  return useScopedQuery({
    queryKey: (pp, wt) => queryKeys.status(pp, wt),
    queryFn: (wt) => api.getStatus(wt),
  });
}

export function useBranchesQuery() {
  return useScopedQuery({
    queryKey: (pp) => queryKeys.branches(pp),
    queryFn: (wt) => api.getBranches(wt),
  });
}

export function useWorktreeStatusesQuery() {
  return useScopedQuery({
    queryKey: (pp) => queryKeys.worktreeStatuses(pp),
    queryFn: (wt) => api.getWorktreeStatuses(wt),
  });
}

export function useDiffQuery(source: DiffSource | null) {
  return useScopedQuery({
    queryKey: (pp) => queryKeys.diff(pp, source),
    queryFn: (wt) => fetchDiff(wt, source),
    extraEnabled: source !== null,
  });
}

export function useDirContentsQuery(dir: string, enabled: boolean) {
  return useScopedQuery({
    queryKey: (pp, wt) => queryKeys.dirContents(pp, toAbsoluteDir(dir, wt)),
    queryFn: (wt) => api.getDirContents(wt, dir),
    extraEnabled: enabled,
    staleTime: Infinity, // WebSocket bridge handles updates via files_dir_changed
  });
}

export function useDetachedFilesQuery() {
  return useScopedQuery({
    queryKey: (pp, wt) => queryKeys.detachedFiles(pp, wt),
    queryFn: (wt) => api.getDetachedFiles(wt),
    staleTime: Infinity, // WebSocket bridge handles updates via detached_files_changed
  });
}

export function useExternalFilesQuery() {
  return useScopedQuery({
    queryKey: (pp, wt) => queryKeys.externalFiles(pp, wt),
    queryFn: (wt) => api.getExternalFiles(wt),
    staleTime: Infinity, // WebSocket bridge handles updates via external_files_changed
  });
}
