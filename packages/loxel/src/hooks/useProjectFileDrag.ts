import type { RefObject } from "react";

import { useCallback, useState } from "react";

import type { TreeNode } from "@/components/tree";

import * as api from "@/api/client";
import { showToast } from "@/components/ui/toast";
import { frontendLog } from "@/lib/frontend-logger";
import { fileParentDir } from "@/lib/project-file-helpers";
import { invalidateDirQueries } from "@/queries/query-helpers";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

export const DETACHED_FILE_DRAG_TYPE = "application/x-detached-file";
const PROJECT_FILE_DRAG_TYPE = "application/x-project-file";

let draggedProjectFilePath: string | null = null;

export function setRowDragImage(e: React.DragEvent) {
  const el = e.currentTarget as HTMLElement;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.style.position = "fixed";
  clone.style.top = "-9999px";
  clone.style.left = "-9999px";
  clone.style.opacity = "0.7";
  clone.style.width = `${el.offsetWidth}px`;
  clone.style.pointerEvents = "none";
  document.body.appendChild(clone);
  e.dataTransfer.setDragImage(clone, e.clientX - el.getBoundingClientRect().left, 10);
  requestAnimationFrame(() => clone.remove());
}

function hasDragType(e: React.DragEvent): boolean {
  return (
    e.dataTransfer.types.includes(DETACHED_FILE_DRAG_TYPE) ||
    e.dataTransfer.types.includes(PROJECT_FILE_DRAG_TYPE)
  );
}

async function moveDetachedFile(filePath: string, destDir: string) {
  try {
    const wt = useWorktreeStore.getState().activeWorktreePath;
    if (!wt) return;
    const { newPath } = await api.moveDetachedFileToProject({
      wt,
      path: filePath,
      destPath: destDir,
    });
    window.dispatchEvent(
      new CustomEvent("loxel-file-moved", { detail: { oldPath: filePath, newPath } }),
    );
  } catch (err) {
    frontendLog
      .child("files")
      .error("Failed to move file", { error: err instanceof Error ? err : undefined });
  }
}

async function moveProjectFile(srcPath: string, destDir: string) {
  try {
    const wt = useWorktreeStore.getState().activeWorktreePath;
    if (!wt) return;
    const { newPath } = await api.moveProjectFile(wt, { srcPath, destDir });
    getCurrentWorktreeUI().getState().renameProjectPaths(srcPath, newPath);
    window.dispatchEvent(
      new CustomEvent("loxel-file-moved", { detail: { oldPath: srcPath, newPath } }),
    );
    const srcParentDir = fileParentDir(srcPath, wt);
    const destDirAbs = destDir || wt;
    invalidateDirQueries(srcParentDir, destDirAbs);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Move failed");
  }
}

export function useProjectFileDrag(
  renamingPath: string | null,
  cutPath: string | null,
  scrollRef: RefObject<HTMLDivElement | null>,
  startAutoScroll: (speed: number) => void,
  stopAutoScroll: () => void,
) {
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);

  const getRowProps = useCallback(
    (node: TreeNode) => {
      const isRenaming = renamingPath === node.path;
      const props: React.HTMLAttributes<HTMLButtonElement> = {};

      if (!isRenaming && node.path !== activeWorktreePath) {
        props.draggable = true;
        props.onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
          e.dataTransfer.setData(PROJECT_FILE_DRAG_TYPE, node.path);
          e.dataTransfer.effectAllowed = "move";
          draggedProjectFilePath = node.path;
          setRowDragImage(e);
        };
        props.onDragEnd = () => {
          draggedProjectFilePath = null;
        };
      }

      if (!node.isDir) {
        const fileParent = fileParentDir(node.path, activeWorktreePath);
        props.onDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
          if (!hasDragType(e)) return;
          if (draggedProjectFilePath !== null) {
            const srcParent = fileParentDir(draggedProjectFilePath, activeWorktreePath);
            if (srcParent === fileParent) {
              e.dataTransfer.dropEffect = "none";
              return;
            }
          }
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDropTargetDir(fileParent);
        };
        props.onDrop = (e: React.DragEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          stopAutoScroll();
          setDropTargetDir(null);
          const detachedPath = e.dataTransfer.getData(DETACHED_FILE_DRAG_TYPE);
          const projectPath = e.dataTransfer.getData(PROJECT_FILE_DRAG_TYPE);
          if (detachedPath) moveDetachedFile(detachedPath, fileParent);
          else if (projectPath) moveProjectFile(projectPath, fileParent);
          draggedProjectFilePath = null;
        };
      }

      if (node.isDir) {
        const dirPath = node.path;
        props.onDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
          if (!hasDragType(e)) return;
          if (draggedProjectFilePath !== null) {
            if (
              dirPath.startsWith(draggedProjectFilePath + "/") ||
              dirPath === draggedProjectFilePath
            ) {
              e.dataTransfer.dropEffect = "none";
              return;
            }
            const srcParent = fileParentDir(draggedProjectFilePath, activeWorktreePath);
            if (srcParent === dirPath) {
              e.dataTransfer.dropEffect = "none";
              return;
            }
          }
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDropTargetDir(dirPath);
        };
        props.onDrop = (e: React.DragEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          stopAutoScroll();
          setDropTargetDir(null);
          const detachedPath = e.dataTransfer.getData(DETACHED_FILE_DRAG_TYPE);
          const projectPath = e.dataTransfer.getData(PROJECT_FILE_DRAG_TYPE);
          if (detachedPath) moveDetachedFile(detachedPath, dirPath);
          else if (projectPath) moveProjectFile(projectPath, dirPath);
          draggedProjectFilePath = null;
        };
      }

      return props;
    },
    [renamingPath, activeWorktreePath, stopAutoScroll],
  );

  const getRowClassName = useCallback(
    (node: TreeNode): string | undefined => {
      const classes: string[] = [];
      if (cutPath === node.path) classes.push("opacity-40");
      if (dropTargetDir === node.path && node.isDir) classes.push("bg-primary/40");
      return classes.length > 0 ? classes.join(" ") : undefined;
    },
    [cutPath, dropTargetDir],
  );

  const onContainerDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setDropTargetDir(null);
        stopAutoScroll();
      }
    },
    [stopAutoScroll],
  );

  const onContainerDrop = useCallback(
    (e: React.DragEvent) => {
      const detachedPath = e.dataTransfer.getData(DETACHED_FILE_DRAG_TYPE);
      const projectPath = e.dataTransfer.getData(PROJECT_FILE_DRAG_TYPE);
      if (detachedPath && dropTargetDir === null) {
        e.preventDefault();
        moveDetachedFile(detachedPath, activeWorktreePath ?? "");
      } else if (projectPath && dropTargetDir === null) {
        const srcParent = fileParentDir(projectPath, activeWorktreePath);
        if (activeWorktreePath && srcParent === activeWorktreePath) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "none";
          setDropTargetDir(null);
          stopAutoScroll();
          draggedProjectFilePath = null;
          return;
        }
        e.preventDefault();
        moveProjectFile(projectPath, activeWorktreePath ?? "");
      }
      setDropTargetDir(null);
      stopAutoScroll();
      draggedProjectFilePath = null;
    },
    [dropTargetDir, activeWorktreePath, stopAutoScroll],
  );

  const onContainerDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!hasDragType(e)) return;
      e.preventDefault();

      const container = scrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const edgeZone = 40;
        const distFromTop = e.clientY - rect.top;
        const distFromBottom = rect.bottom - e.clientY;

        if (distFromTop < edgeZone) {
          const speed = -Math.round(6 * (1 - distFromTop / edgeZone));
          stopAutoScroll();
          startAutoScroll(speed);
        } else if (distFromBottom < edgeZone) {
          const speed = Math.round(6 * (1 - distFromBottom / edgeZone));
          stopAutoScroll();
          startAutoScroll(speed);
        } else {
          stopAutoScroll();
        }
      }
    },
    [scrollRef, startAutoScroll, stopAutoScroll],
  );

  return {
    dropTargetDir,
    getRowProps,
    getRowClassName,
    onContainerDragLeave,
    onContainerDrop,
    onContainerDragOver,
  };
}
