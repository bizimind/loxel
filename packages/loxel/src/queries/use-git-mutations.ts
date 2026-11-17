import { useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "@/api/client";
import { localRef } from "@/api/local-server";
import { isWorkingTreeDiffKey, queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";
import { getActiveWt } from "@/store/active-worktree";

export function useStageFilesMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (files: string[]) => api.stageFiles(getActiveWt(), files),
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
    mutationFn: (files: string[]) => api.unstageFiles(getActiveWt(), files),
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
    mutationFn: (files: string[]) => api.discardChanges(getActiveWt(), files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
}

/** Discard all local changes to files of a worktree (not necessarily the active one). */
export function useRevertToHeadMutation() {
  const queryClient = useQueryClient();
  const { activeProject } = useQueryScope();

  return useMutation({
    mutationFn: ({ worktree, files }: { worktree: string; files: string[] }) =>
      api.revertToHead(worktree, files),
    onSuccess: (_data, { worktree }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.status(activeProject, localRef(worktree)),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.worktreeStatuses(activeProject) });
      queryClient.invalidateQueries({
        predicate: (query) => isWorkingTreeDiffKey(query.queryKey, activeProject),
      });
    },
  });
}

export function useCheckoutMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (ref: string) => api.checkout(getActiveWt(), ref),
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
      api.reset(getActiveWt(), commit, mode),
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
    mutationFn: (message: string) => api.createCommit(getActiveWt(), message),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
    },
  });
}

export function useCreateBranchMutation() {
  const queryClient = useQueryClient();
  const { activeProject } = useQueryScope();

  return useMutation({
    mutationFn: ({ name, startPoint }: { name: string; startPoint?: string }) =>
      api.createBranch(getActiveWt(), name, startPoint),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.branches(activeProject) });
    },
  });
}

export function useDeleteBranchMutation() {
  const queryClient = useQueryClient();
  const { activeProject } = useQueryScope();

  return useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      api.deleteBranch(getActiveWt(), name, force),
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
    mutationFn: (commits: string[]) => api.cherryPick(getActiveWt(), commits),
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
    mutationFn: (commits: string[]) => api.revert(getActiveWt(), commits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.commitsAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
    },
  });
}

export function useRenameBranchMutation() {
  const queryClient = useQueryClient();
  const { activeProject } = useQueryScope();

  return useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      api.renameBranch(getActiveWt(), oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.branches(activeProject) });
    },
  });
}

export function useStageHunkMutation() {
  const queryClient = useQueryClient();
  const { activeProject, activeWorktree } = useQueryScope();

  return useMutation({
    mutationFn: (patch: string) => api.stageHunk(getActiveWt(), patch),
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
    mutationFn: (patch: string) => api.unstageHunk(getActiveWt(), patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status(activeProject, activeWorktree) });
      queryClient.invalidateQueries({ queryKey: queryKeys.diffAll() });
    },
  });
}
