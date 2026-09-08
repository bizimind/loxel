import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";

import * as api from "@/api/client";
import type { FileOperationResult } from "@/api/file-operations-model";
import type { FilesTreeHandle } from "@/components/tree";
import { showToast } from "@/components/ui/toast";
import { frontendLog } from "@/lib/frontend-logger";
import { fileParentDir } from "@/lib/project-file-helpers";
import { invalidateDirQueries } from "@/queries/query-helpers";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

function dispatchUndoRedoResult(result: FileOperationResult) {
  const wt = useWorktreeStore.getState().activeWorktreePath;
  switch (result.type) {
    case "rename":
    case "move": {
      getCurrentWorktreeUI().getState().renameProjectPaths(result.oldPath, result.newPath);
      window.dispatchEvent(
        new CustomEvent("loxel-file-moved", {
          detail: { oldPath: result.oldPath, newPath: result.newPath },
        }),
      );
      const oldParent = fileParentDir(result.oldPath, wt);
      const newParent = fileParentDir(result.newPath, wt);
      invalidateDirQueries(oldParent, newParent);
      break;
    }
    case "delete":
      window.dispatchEvent(
        new CustomEvent("loxel-file-deleted", { detail: { filePath: result.path } }),
      );
      if (wt) {
        invalidateDirQueries(fileParentDir(result.path, wt));
      }
      break;
    case "restore":
    case "create":
      if (wt) {
        invalidateDirQueries(fileParentDir(result.path, wt));
      }
      break;
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown FileOperationResult type: ${String(_exhaustive)}`);
    }
  }
}

export function useFileOperations(
  isDetachedPath: (path: string) => boolean,
  treeRef: RefObject<FilesTreeHandle | null>,
) {
  // --- Inline rename ---
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const handleStartRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleFinishRename = useCallback(
    async (path: string, newName: string) => {
      setRenamingPath(null);
      const oldName = path.split("/").pop()!;
      if (newName === oldName || !newName) {
        treeRef.current?.focusPath(path);
        return;
      }
      try {
        const wt = useWorktreeStore.getState().activeWorktreePath;
        if (!wt) {
          treeRef.current?.focusPath(path);
          return;
        }

        let newPath: string;
        if (isDetachedPath(path)) {
          await api.renameDetachedFile(wt, path, newName);
          newPath = path.slice(0, path.lastIndexOf("/") + 1) + newName;
        } else {
          ({ newPath } = await api.renameProjectFile(wt, { path, newName }));
        }
        getCurrentWorktreeUI().getState().renameProjectPaths(path, newPath);
        treeRef.current?.handlePathsRenamed(path, newPath);
        window.dispatchEvent(
          new CustomEvent("loxel-file-moved", { detail: { oldPath: path, newPath } }),
        );
        invalidateDirQueries(fileParentDir(path, wt));
        treeRef.current?.focusPath(newPath);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Rename failed");
        treeRef.current?.focusPath(path);
      }
    },
    [isDetachedPath, treeRef],
  );

  const handleCancelRename = useCallback(() => {
    const path = renamingPath;
    setRenamingPath(null);
    if (path) treeRef.current?.focusPath(path);
  }, [renamingPath, treeRef]);

  // --- Delete ---
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; isDir: boolean } | null>(null);

  const handleRequestDelete = useCallback((path: string, isDir: boolean) => {
    setDeleteTarget({ path, isDir });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const { path } = deleteTarget;
    setDeleteTarget(null);
    try {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return;

      if (isDetachedPath(path)) {
        await api.deleteDetachedFile(wt, path);
      } else {
        await api.deleteProjectFile(wt, path);
      }
      window.dispatchEvent(new CustomEvent("loxel-file-deleted", { detail: { filePath: path } }));
      const sel = getCurrentWorktreeUI().getState().selectedProjectFile;
      if (sel === path || sel?.startsWith(path + "/")) {
        getCurrentWorktreeUI().getState().setSelectedProjectFile(null);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed");
    }
  }, [deleteTarget, isDetachedPath]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  // --- Undo / Redo ---
  const operationPendingRef = useRef(false);

  const handleUndo = useCallback(async () => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    try {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return;
      const { result } = await api.undoFileOperation(wt);
      if (result) dispatchUndoRedoResult(result);
    } catch (err) {
      frontendLog
        .child("files")
        .error("Undo failed", { error: err instanceof Error ? err : undefined });
    } finally {
      operationPendingRef.current = false;
    }
  }, []);

  const handleRedo = useCallback(async () => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    try {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return;
      const { result } = await api.redoFileOperation(wt);
      if (result) dispatchUndoRedoResult(result);
    } catch (err) {
      frontendLog
        .child("files")
        .error("Redo failed", { error: err instanceof Error ? err : undefined });
    } finally {
      operationPendingRef.current = false;
    }
  }, []);

  // --- New File / New Directory ---
  const handleNewFile = useCallback(
    async (dir: string) => {
      try {
        const wt = useWorktreeStore.getState().activeWorktreePath;
        if (!wt) return;
        treeRef.current?.expandPath(dir);
        const { path } = await api.createProjectFile(wt, { dir });
        setRenamingPath(path);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Create file failed");
      }
    },
    [treeRef],
  );

  const handleNewDir = useCallback(
    async (dir: string) => {
      try {
        const wt = useWorktreeStore.getState().activeWorktreePath;
        if (!wt) return;
        treeRef.current?.expandPath(dir);
        const { path } = await api.createProjectDir(wt, { dir });
        setRenamingPath(path);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Create directory failed");
      }
    },
    [treeRef],
  );

  return {
    renamingPath,
    deleteTarget,
    handleStartRename,
    handleFinishRename,
    handleCancelRename,
    handleRequestDelete,
    handleConfirmDelete,
    handleCancelDelete,
    handleUndo,
    handleRedo,
    handleNewFile,
    handleNewDir,
  };
}
