import { useQueryClient } from "@tanstack/react-query";
import type { DockviewPanelApi } from "dockview-react";
import { CheckIcon, CopyIcon, CrosshairIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/api/client";
import type { DirEntry, ProjectFileStatus } from "@/api/project-files-model";
import { ProjectFileMenu } from "@/components/menus/ProjectFileMenu";
import { DetachedFileNode } from "@/components/panels/DetachedFileNode";
import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";
import { ExternalFileNode } from "@/components/panels/ExternalFileNode";
import type { FilesTreeHandle, TreeNode } from "@/components/tree";
import { FilesTree, InlineRenameInput, TREE_PATH_ATTR } from "@/components/tree";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { showToast } from "@/components/ui/toast";
import { useDragAutoScroll } from "@/hooks/useDragAutoScroll";
import { useFileClipboard } from "@/hooks/useFileClipboard";
import { useFileOperations } from "@/hooks/useFileOperations";
import { usePanelActive } from "@/hooks/usePanelActive";
import { useProjectFileDrag } from "@/hooks/useProjectFileDrag";
import { getTreeActionForEvent, useTreeKeyboardNav } from "@/hooks/useTreeKeyboardNav";
import { getDisplayFilename, toAbsoluteDir } from "@/lib/detached-path";
import { onLoxelEvent } from "@/lib/loxel-events";
import { dispatchOpenFile } from "@/lib/open-file";
import { fileParentDir, parentDir, pathName, statusColorClass } from "@/lib/project-file-helpers";
import { getActiveEditorFilePath } from "@/lib/reveal-in-explorer";
import { cn } from "@/lib/utils";
import { removeDirQueries } from "@/queries/query-helpers";
import { queryKeys } from "@/queries/query-keys";
import { useDiscardChangesMutation } from "@/queries/use-git-mutations";
import { useDetachedFilesQuery, useExternalFilesQuery } from "@/queries/use-repo-queries";
import { getQueryScope } from "@/queries/use-scope";
import { useSettingsStore } from "@/store/settings-store";
import { getCenterApi, subscribeCenterApi } from "@/store/tools-bar";
import { getCurrentWorktreeUI, useWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

// --- Main component ---

export function ProjectFilesPanel({ panelApi }: { panelApi?: DockviewPanelApi }) {
  const isPanelActive = usePanelActive(panelApi);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();
  const treeRef = useRef<FilesTreeHandle>(null);

  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const displayPath = activeWorktreePath;
  const rootName = displayPath ? displayPath.split("/").pop() || displayPath : "Project";
  const expandedProjectFolders = useWorktreeUI((s) => s.expandedProjectFolders);
  const setExpandedProjectFolders = useWorktreeUI((s) => s.setExpandedProjectFolders);
  const initializedRootPathsRef = useRef(new Set<string>());
  const focusedRootPathsRef = useRef(new Set<string>());

  const handleCopy = useCallback(() => {
    if (!displayPath) return;
    navigator.clipboard.writeText(displayPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [displayPath]);

  // --- Detached and external files ---
  const { data: detachedFiles } = useDetachedFilesQuery();
  const hasDetachedFiles = detachedFiles && detachedFiles.length > 0;
  const detachedPathSet = useMemo(
    () => new Set(detachedFiles?.map((e) => e.path)),
    [detachedFiles],
  );
  const isDetachedPath = useCallback((p: string) => detachedPathSet.has(p), [detachedPathSet]);

  const { data: externalFiles } = useExternalFilesQuery();
  const hasExternalFiles = externalFiles && externalFiles.length > 0;

  // --- Context menu ---
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    path: string;
    isDir: boolean;
    status?: ProjectFileStatus;
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string, isDir: boolean, status?: ProjectFileStatus) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ position: { x: e.clientX, y: e.clientY }, path, isDir, status });
    },
    [],
  );

  // --- File operations (rename, delete, undo/redo, new file/dir) ---
  const {
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
  } = useFileOperations(isDetachedPath, treeRef);

  // --- Reveal in explorer ---
  const revealFileInTree = useCallback(
    async (filePath: string) => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return;
      const isProjectFile = filePath.startsWith(wt + "/");
      if (isProjectFile) {
        const relativePath = filePath.slice(wt.length + 1);
        const segments = relativePath.split("/");
        const ancestors: string[] = [wt];
        for (let i = 0; i < segments.length - 1; i++) {
          ancestors.push(`${wt}/${segments.slice(0, i + 1).join("/")}`);
        }
        const { activeProjectPath } = getQueryScope();
        for (const dir of ancestors) {
          await queryClient.fetchQuery({
            queryKey: queryKeys.dirContents(activeProjectPath, dir),
            queryFn: () => api.getDirContents(wt, dir),
            staleTime: Infinity,
          });
        }
      }
      getCurrentWorktreeUI().getState().setSelectedProjectFile(filePath);
      await treeRef.current?.revealPath(filePath);
    },
    [queryClient],
  );

  useEffect(() => {
    return onLoxelEvent("loxel-reveal-in-explorer", ({ filePath }) => {
      revealFileInTree(filePath).catch(() => {});
    });
  }, [revealFileInTree]);

  const autoReveal = useSettingsStore((s) => s.autoRevealInExplorer);
  const [centerApi, setCenterApiState] = useState(() => getCenterApi());
  const [activeEditorFilePath, setActiveEditorFilePath] = useState(() => getActiveEditorFilePath());
  useEffect(() => subscribeCenterApi(setCenterApiState), []);

  useEffect(() => {
    if (!centerApi) {
      setActiveEditorFilePath(null);
      return;
    }
    const updateActiveEditorFilePath = () => setActiveEditorFilePath(getActiveEditorFilePath());
    updateActiveEditorFilePath();
    const disposable = centerApi.onDidActivePanelChange(updateActiveEditorFilePath);
    return () => disposable.dispose();
  }, [centerApi]);

  useEffect(() => {
    if (!autoReveal || !activeEditorFilePath) return;
    revealFileInTree(activeEditorFilePath).catch(() => {});
  }, [autoReveal, activeEditorFilePath, revealFileInTree]);

  const handleRevealActive = useCallback(() => {
    const filePath = getActiveEditorFilePath();
    if (filePath) {
      revealFileInTree(filePath).catch(() => {});
    }
  }, [revealFileInTree]);

  const scrollRef = useRef<HTMLDivElement>(null);

  // --- Clipboard ---
  const { clipboard, cutPath, handleCut, handleCopyFile, handlePaste, resolveTargetDir } =
    useFileClipboard(isDetachedPath, queryClient, activeWorktreePath);

  // --- Git restore (discard changes) ---
  const discardMutation = useDiscardChangesMutation();
  const [restoreTarget, setRestoreTarget] = useState<{ path: string; isDir: boolean } | null>(null);

  const handleRequestRestore = useCallback((path: string, isDir: boolean) => {
    setRestoreTarget({ path, isDir });
  }, []);

  const handleConfirmRestore = useCallback(async () => {
    if (!restoreTarget) return;
    const { path } = restoreTarget;
    setRestoreTarget(null);
    try {
      await discardMutation.mutateAsync([path]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Git restore failed");
    }
  }, [restoreTarget, discardMutation]);

  const { startAutoScroll, stopAutoScroll } = useDragAutoScroll(scrollRef);
  const {
    getRowProps,
    getRowClassName,
    onContainerDragLeave,
    onContainerDrop,
    onContainerDragOver,
  } = useProjectFileDrag(renamingPath, cutPath, scrollRef, startAutoScroll, stopAutoScroll);

  // --- FilesTree: loadSubtree ---
  const rootNodes = useMemo<TreeNode[]>(
    () => (activeWorktreePath ? [{ path: activeWorktreePath, name: rootName, isDir: true }] : []),
    [activeWorktreePath, rootName],
  );

  useEffect(() => {
    if (
      !activeWorktreePath ||
      initializedRootPathsRef.current.has(activeWorktreePath) ||
      expandedProjectFolders.has(activeWorktreePath)
    ) {
      return;
    }
    initializedRootPathsRef.current.add(activeWorktreePath);
    const next = new Set(expandedProjectFolders);
    next.add(activeWorktreePath);
    setExpandedProjectFolders(next);
  }, [activeWorktreePath, expandedProjectFolders, setExpandedProjectFolders]);

  useEffect(() => {
    if (!activeWorktreePath || focusedRootPathsRef.current.has(activeWorktreePath)) return;
    focusedRootPathsRef.current.add(activeWorktreePath);
    treeRef.current?.focusPath(activeWorktreePath);
  }, [activeWorktreePath]);

  const loadSubtree = useCallback(
    async (path: string): Promise<TreeNode[]> => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return [];
      const { activeProjectPath } = getQueryScope();
      const absDir = toAbsoluteDir(path, wt);
      const entries = await queryClient.fetchQuery({
        queryKey: queryKeys.dirContents(activeProjectPath, absDir),
        queryFn: () => api.getDirContents(wt, path),
        staleTime: Infinity,
      });
      return entries.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir }));
    },
    [queryClient],
  );

  // --- FilesTree: rendering callbacks ---

  const getEntryStatus = useCallback(
    (path: string): ProjectFileStatus | undefined => {
      if (path === activeWorktreePath) return undefined;
      const dir = fileParentDir(path, activeWorktreePath);
      const { activeProjectPath } = getQueryScope();
      const absDir = toAbsoluteDir(dir, activeWorktreePath);
      const entries = queryClient.getQueryData<DirEntry[]>(
        queryKeys.dirContents(activeProjectPath, absDir),
      );
      const name = pathName(path);
      return entries?.find((e) => e.name === name)?.status;
    },
    [queryClient, activeWorktreePath],
  );

  const renderLabel = useCallback(
    (node: TreeNode, compactedWith?: TreeNode): ReactNode => {
      // Compacted dirs: render per-segment spans
      if (compactedWith) {
        const segments = [
          { name: node.name, path: node.path },
          { name: compactedWith.name, path: compactedWith.path },
        ];
        const status = getEntryStatus(compactedWith.path);
        return (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              statusColorClass(status) ?? "text-tree-folder",
            )}
          >
            {segments.map((seg, i) => (
              <span key={seg.path}>
                {i > 0 && <span className="text-muted-foreground mx-0.5">/</span>}
                {renamingPath === seg.path ? (
                  <InlineRenameInput
                    currentName={seg.name}
                    isDir
                    onFinish={(newName) => handleFinishRename(seg.path, newName)}
                    onCancel={handleCancelRename}
                  />
                ) : (
                  <span>{seg.name}</span>
                )}
              </span>
            ))}
          </span>
        );
      }

      // Inline rename
      if (renamingPath === node.path) {
        return (
          <InlineRenameInput
            currentName={node.name}
            isDir={node.isDir}
            onFinish={(newName) => handleFinishRename(node.path, newName)}
            onCancel={handleCancelRename}
          />
        );
      }

      // Root node: bold
      if (node.path === activeWorktreePath && node.isDir) {
        return (
          <span className="text-tree-folder min-w-0 flex-1 truncate text-left font-semibold">
            {node.name}
          </span>
        );
      }

      // Dir/file with status color
      const status = getEntryStatus(node.path);
      const colorClass = node.isDir
        ? (statusColorClass(status) ?? "text-tree-folder")
        : statusColorClass(status);
      if (colorClass) {
        return <span className={cn("min-w-0 flex-1 truncate", colorClass)}>{node.name}</span>;
      }

      return undefined;
    },
    [renamingPath, handleFinishRename, handleCancelRename, getEntryStatus],
  );

  // --- FilesTree event handlers ---

  const handleTreeSelect = useCallback((path: string) => {
    getCurrentWorktreeUI().getState().setSelectedProjectFile(path);
    setContextMenu(null);
  }, []);

  const handleTreeToggle = useCallback(
    (path: string, expanded: boolean) => {
      if (!expanded && activeWorktreePath) {
        treeRef.current?.clearSubtree(path);
        api.unwatchDir(activeWorktreePath, path);
        removeDirQueries(queryClient, path);
      }
    },
    [activeWorktreePath, queryClient],
  );

  const handleTreeContextMenu = useCallback(
    (e: React.MouseEvent, path: string, isDir: boolean) => {
      const status = getEntryStatus(path);
      handleContextMenu(e, path, isDir, status);
    },
    [handleContextMenu, getEntryStatus],
  );

  // --- WS dir-changed → reloadSubtree ---
  useEffect(() => {
    return onLoxelEvent("loxel-dir-changed", ({ dir }) => {
      treeRef.current?.reloadSubtree(dir);
    });
  }, []);

  // --- Keyboard shortcuts ---
  const handleTreeKeyDown = useTreeKeyboardNav(scrollRef, (path) => {
    treeRef.current?.togglePath(path);
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingPath) return;

      const isMeta = e.metaKey || e.ctrlKey;

      if (isMeta && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (isMeta && e.key === "z") {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (handleTreeKeyDown(e)) return;

      const treeActionId = getTreeActionForEvent(e);
      if (treeActionId === "tree.open" || treeActionId === "tree.rename") {
        const eventTarget = e.target as HTMLElement | null;
        const focused =
          eventTarget?.closest<HTMLElement>(`button[${TREE_PATH_ATTR}]`) ??
          (document.activeElement as HTMLElement | null);
        const focusedPath = focused?.getAttribute(TREE_PATH_ATTR);
        if (!focused || !focusedPath) return;
        const isFocusedRoot = focusedPath === activeWorktreePath;
        if (treeActionId === "tree.open") {
          e.preventDefault();
          if (focused.hasAttribute("data-tree-dir")) {
            treeRef.current?.togglePath(focusedPath);
          } else {
            dispatchOpenFile(focusedPath);
          }
          return;
        }
        if (isFocusedRoot) return;
        e.preventDefault();
        handleStartRename(focusedPath);
        return;
      }

      const selected = getCurrentWorktreeUI().getState().selectedProjectFile;
      if (!selected) return;

      const isDetached = isDetachedPath(selected);
      const isRoot = selected === activeWorktreePath;

      if (isMeta && e.key === "x") {
        if (isRoot) return;
        e.preventDefault();
        handleCut(selected);
        return;
      }
      if (isMeta && e.key === "c") {
        if (isRoot) return;
        e.preventDefault();
        handleCopyFile(selected);
        return;
      }
      if (isMeta && e.key === "v" && clipboard) {
        if (isDetached) return;
        e.preventDefault();
        handlePaste(resolveTargetDir(selected));
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (isRoot) return;
        e.preventDefault();
        if (isDetached) {
          handleRequestDelete(selected, false);
        } else {
          const parentDirPath = fileParentDir(selected, activeWorktreePath);
          const entryName = pathName(selected);
          const { activeProjectPath: projectPath } = getQueryScope();
          const absDirPath = toAbsoluteDir(parentDirPath, activeWorktreePath);
          const parentEntries = queryClient.getQueryData<DirEntry[]>(
            queryKeys.dirContents(projectPath, absDirPath),
          );
          const isDir = parentEntries?.find((entry) => entry.name === entryName)?.isDir ?? false;
          handleRequestDelete(selected, isDir);
        }
      }
    },
    [
      renamingPath,
      clipboard,
      isDetachedPath,
      activeWorktreePath,
      handleTreeKeyDown,
      handleStartRename,
      handleRequestDelete,
      handleUndo,
      handleRedo,
      handleCut,
      handleCopyFile,
      handlePaste,
      resolveTargetDir,
    ],
  );

  // --- Derived values for context menu and delete dialog ---
  const ctxIsDraft = contextMenu ? isDetachedPath(contextMenu.path) : false;
  const ctxIsRoot = contextMenu?.path === activeWorktreePath;
  const ctxIsModified = contextMenu?.status === "modified" && !ctxIsDraft && !ctxIsRoot;

  const deleteDescription = (() => {
    if (!deleteTarget) return "";
    const isDetached = isDetachedPath(deleteTarget.path);
    const displayName = isDetached ? getDisplayFilename(deleteTarget.path) : deleteTarget.path;
    const undoHint = isDetached ? "" : " This can be undone with Cmd+Z.";
    return deleteTarget.isDir
      ? `Delete "${displayName}" and all its contents?${undoHint}`
      : `Delete "${displayName}"?${undoHint}`;
  })();

  const selectedProjectFile = useWorktreeUI((s) => s.selectedProjectFile);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DraggablePanelHeader panelId="projectFiles">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-bold">Project Files</h2>
          <button
            onClick={handleRevealActive}
            className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            title="Reveal active editor in tree"
          >
            <CrosshairIcon className="size-3.5" />
          </button>
        </div>
        {displayPath && (
          <div className="mt-1 flex items-center gap-1">
            <span className="text-muted-foreground min-w-0 truncate text-[11px]" dir="rtl">
              {displayPath}
            </span>
            <button
              onClick={handleCopy}
              className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-colors"
              title="Copy path"
            >
              {copied ? (
                <CheckIcon className="size-3 text-green-500" />
              ) : (
                <CopyIcon className="size-3" />
              )}
            </button>
          </div>
        )}
      </DraggablePanelHeader>

      {/* oxlint-disable-next-line jsx-no-autofocus */}
      <div
        ref={scrollRef}
        className="flex-1 scrollbar-thin overflow-y-auto py-1"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onFocusCapture={(e) => {
          const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
            `button[${TREE_PATH_ATTR}]`,
          );
          if (!btn) return;
          const path = btn.getAttribute(TREE_PATH_ATTR);
          if (path !== null) {
            getCurrentWorktreeUI().getState().setSelectedProjectFile(path);
            setContextMenu(null);
          }
        }}
        onDragLeave={onContainerDragLeave}
        onDrop={onContainerDrop}
        onDragOverCapture={onContainerDragOver}
      >
        {hasDetachedFiles && (
          <>
            <div className="px-3 py-1">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
                Drafts
              </span>
            </div>
            {detachedFiles.map((entry) => (
              <DetachedFileNode
                key={entry.name}
                entry={entry}
                isPanelActive={isPanelActive}
                onContextMenu={handleContextMenu}
                renamingPath={renamingPath}
                onFinishRename={handleFinishRename}
                onCancelRename={handleCancelRename}
              />
            ))}
            <div className="border-border mx-2 my-1.5 border-t" />
          </>
        )}

        <FilesTree
          ref={treeRef}
          nodes={rootNodes}
          loadSubtree={loadSubtree}
          expandedPaths={expandedProjectFolders}
          onExpandedPathsChange={setExpandedProjectFolders}
          onOpen={dispatchOpenFile}
          onSelect={handleTreeSelect}
          onToggle={handleTreeToggle}
          onContextMenu={handleTreeContextMenu}
          focusedPath={selectedProjectFile}
          activePath={activeEditorFilePath}
          renderLabel={renderLabel}
          getRowProps={getRowProps}
          getRowClassName={getRowClassName}
          isPanelActive={isPanelActive}
          compactRoot={false}
          disableBuiltinKeyNav
        />

        {hasExternalFiles && (
          <>
            <div className="border-border mx-2 my-1.5 border-t" />
            <div className="px-3 py-1">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
                Others
              </span>
            </div>
            {externalFiles.map((entry) => (
              <ExternalFileNode key={entry.path} entry={entry} isPanelActive={isPanelActive} />
            ))}
          </>
        )}
      </div>

      {contextMenu && (
        <ProjectFileMenu
          open
          position={contextMenu.position}
          filePath={contextMenu.path}
          isDir={contextMenu.isDir}
          canPaste={clipboard !== null}
          onClose={() => setContextMenu(null)}
          onNewFile={
            !ctxIsDraft
              ? () => handleNewFile(parentDir(contextMenu.path, contextMenu.isDir))
              : undefined
          }
          onNewDir={
            !ctxIsDraft
              ? () => handleNewDir(parentDir(contextMenu.path, contextMenu.isDir))
              : undefined
          }
          onRename={!ctxIsRoot ? () => handleStartRename(contextMenu.path) : undefined}
          onDelete={
            !ctxIsRoot ? () => handleRequestDelete(contextMenu.path, contextMenu.isDir) : undefined
          }
          onCut={!ctxIsRoot ? () => handleCut(contextMenu.path) : undefined}
          onCopy={!ctxIsRoot ? () => handleCopyFile(contextMenu.path) : undefined}
          onPaste={
            !ctxIsDraft
              ? () =>
                  handlePaste(
                    ctxIsRoot && activeWorktreePath
                      ? activeWorktreePath
                      : parentDir(contextMenu.path, contextMenu.isDir),
                  )
              : undefined
          }
          onGitRestore={
            ctxIsModified
              ? () => handleRequestRestore(contextMenu.path, contextMenu.isDir)
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.isDir ? "Delete directory" : "Delete file"}
        description={deleteDescription}
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        title="Git Restore"
        description={
          restoreTarget?.isDir
            ? `Discard all changes in "${restoreTarget.path}" and its contents? This cannot be undone.`
            : `Discard changes to "${restoreTarget?.path ?? ""}"? This cannot be undone.`
        }
        confirmLabel="Discard"
        destructive
        onConfirm={handleConfirmRestore}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}
