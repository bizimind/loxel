import { useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "@/api/client";
import type { WorktreeRef } from "@/api/worktree-ref";
import { isWorkingTreeDiffKey, queryKeys } from "@/queries/query-keys";
import { projectRefOf, useQueryScope } from "@/queries/use-scope";

/**
 * The worktree a git mutation runs in: the active one of the render that started it, whose scope
 * also names the keys its success refreshes, so both concern the same worktree even if the window
 * switches meanwhile.
 */
function required(activeWorktree: WorktreeRef | null): WorktreeRef {
  if (!activeWorktree) throw new Error("No active worktree");
  return activeWorktree;
}

export function useStageFilesMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (files: string[]) => api.stageFiles(required(activeWorktree).path, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
}

export function useUnstageFilesMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (files: string[]) => api.unstageFiles(required(activeWorktree).path, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
}

export function useDiscardChangesMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (files: string[]) => api.discardChanges(required(activeWorktree).path, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
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
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (ref: string) => api.checkout(required(activeWorktree).path, ref),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.branches(activeProject) });
    },
  });
}

export function useResetMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: ({ commit, mode }: { commit: string; mode: "soft" | "mixed" | "hard" }) =>
      api.reset(required(activeWorktree).path, commit, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
    },
  });
}

export function useCreateCommitMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (message: string) => api.createCommit(required(activeWorktree).path, message),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
    },
  });
}

export function useCreateBranchMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: ({ name, startPoint }: { name: string; startPoint?: string }) =>
      api.createBranch(required(activeWorktree).path, name, startPoint),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.branches(activeProject) });
    },
  });
}

export function useDeleteBranchMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      api.deleteBranch(required(activeWorktree).path, name, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.branches(activeProject) });
    },
  });
}

export function useCherryPickMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (commits: string[]) => api.cherryPick(required(activeWorktree).path, commits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
    },
  });
}

export function useRevertMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (commits: string[]) => api.revert(required(activeWorktree).path, commits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
    },
  });
}

export function useRenameBranchMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      api.renameBranch(required(activeWorktree).path, oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.branches(activeProject) });
    },
  });
}

export function useStageHunkMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (patch: string) => api.stageHunk(required(activeWorktree).path, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
}

export function useUnstageHunkMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (patch: string) => api.unstageHunk(required(activeWorktree).path, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
}
