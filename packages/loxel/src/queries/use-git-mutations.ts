import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "@/api/client";
import type { WorktreeRef } from "@/api/worktree-ref";
import { isWorkingTreeDiffKey, queryKeys } from "@/queries/query-keys";
import { projectRefOf, useQueryScope } from "@/queries/use-scope";

/** The worktree a git mutation runs in, and its project. */
interface MutationScope {
  project: WorktreeRef | null;
  wt: WorktreeRef;
}

/** The active worktree of a render that starts a mutation; throws in Home. */
function required(activeWorktree: WorktreeRef | null): WorktreeRef {
  if (!activeWorktree) throw new Error("No active worktree");
  return activeWorktree;
}

/**
 * A git mutation of the active worktree. Its worktree and project are those of the render that
 * started it: the request goes out right after `onMutate`, before any re-render, and the scope
 * `onMutate` returns is kept with the mutation, so its success refreshes that worktree's queries
 * even if the window switched meanwhile (a re-render hands a pending mutation the new render's
 * callbacks, but not a new context).
 */
function useWorktreeMutation<TVariables, TData>(
  run: (wtPath: string, variables: TVariables) => Promise<TData>,
  invalidate: (queryClient: QueryClient, scope: MutationScope) => void,
) {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    onMutate: (): MutationScope => ({ project: activeProject, wt: required(activeWorktree) }),
    mutationFn: (variables: TVariables) => run(required(activeWorktree).path, variables),
    onSuccess: (_data, _variables, scope) => invalidate(queryClient, scope),
  });
}

const refreshStatus = (qc: QueryClient, { project, wt }: MutationScope) =>
  qc.invalidateQueries({ queryKey: queryKeys.status(project, wt) });

/** Status and every diff: staging or discarding changes what the diffs compare. */
function refreshStatusAndDiffs(qc: QueryClient, scope: MutationScope): void {
  void refreshStatus(qc, scope);
  void qc.invalidateQueries({ queryKey: queryKeys.diffAll() });
}

/** The commit graphs and the status: a new commit or a reset moves HEAD. */
function refreshCommitsAndStatus(qc: QueryClient, scope: MutationScope): void {
  void qc.invalidateQueries({ queryKey: queryKeys.commitsAll() });
  void refreshStatus(qc, scope);
}

/** The commit graphs and the branch list. */
function refreshCommitsAndBranches(qc: QueryClient, { project }: MutationScope): void {
  void qc.invalidateQueries({ queryKey: queryKeys.commitsAll() });
  void qc.invalidateQueries({ queryKey: queryKeys.branches(project) });
}

export function useStageFilesMutation() {
  return useWorktreeMutation(
    (wt, files: string[]) => api.stageFiles(wt, files),
    refreshStatusAndDiffs,
  );
}

export function useUnstageFilesMutation() {
  return useWorktreeMutation(
    (wt, files: string[]) => api.unstageFiles(wt, files),
    refreshStatusAndDiffs,
  );
}

export function useDiscardChangesMutation() {
  return useWorktreeMutation(
    (wt, files: string[]) => api.discardChanges(wt, files),
    refreshStatusAndDiffs,
  );
}

/** Discard all local changes to files of a worktree (not necessarily the active one). */
export function useRevertToHeadMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ worktree, files }: { worktree: WorktreeRef; files: string[] }) =>
      api.revertToHead(worktree.path, files),
    onSuccess: (_data, { worktree }) => {
      // The worktree's own project, not the active one's: they differ if the window switched.
      const project = projectRefOf(worktree);
      queryClient.invalidateQueries({ queryKey: queryKeys.status(project, worktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.worktreeStatuses(project) });
      queryClient.invalidateQueries({
        predicate: (query) => isWorkingTreeDiffKey(query.queryKey, project),
      });
    },
  });
}

export function useCheckoutMutation() {
  return useWorktreeMutation(
    (wt, ref: string) => api.checkout(wt, ref),
    (qc, scope) => {
      void refreshStatus(qc, scope);
      refreshCommitsAndBranches(qc, scope);
    },
  );
}

export function useResetMutation() {
  return useWorktreeMutation(
    (wt, { commit, mode }: { commit: string; mode: "soft" | "mixed" | "hard" }) =>
      api.reset(wt, commit, mode),
    refreshCommitsAndStatus,
  );
}

export function useCreateCommitMutation() {
  return useWorktreeMutation(
    (wt, message: string) => api.createCommit(wt, message),
    refreshCommitsAndStatus,
  );
}

export function useCreateBranchMutation() {
  return useWorktreeMutation(
    (wt, { name, startPoint }: { name: string; startPoint?: string }) =>
      api.createBranch(wt, name, startPoint),
    refreshCommitsAndBranches,
  );
}

export function useDeleteBranchMutation() {
  return useWorktreeMutation(
    (wt, { name, force }: { name: string; force?: boolean }) => api.deleteBranch(wt, name, force),
    refreshCommitsAndBranches,
  );
}

export function useCherryPickMutation() {
  return useWorktreeMutation(
    (wt, commits: string[]) => api.cherryPick(wt, commits),
    refreshCommitsAndStatus,
  );
}

export function useRevertMutation() {
  return useWorktreeMutation(
    (wt, commits: string[]) => api.revert(wt, commits),
    refreshCommitsAndStatus,
  );
}

export function useRenameBranchMutation() {
  return useWorktreeMutation(
    (wt, { oldName, newName }: { oldName: string; newName: string }) =>
      api.renameBranch(wt, oldName, newName),
    (qc, { project }) => void qc.invalidateQueries({ queryKey: queryKeys.branches(project) }),
  );
}

export function useStageHunkMutation() {
  return useWorktreeMutation(
    (wt, patch: string) => api.stageHunk(wt, patch),
    refreshStatusAndDiffs,
  );
}

export function useUnstageHunkMutation() {
  return useWorktreeMutation(
    (wt, patch: string) => api.unstageHunk(wt, patch),
    refreshStatusAndDiffs,
  );
}
