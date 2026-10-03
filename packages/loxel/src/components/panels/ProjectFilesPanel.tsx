import { useQueryClient } from "@tanstack/react-query";
import type { DockviewPanelApi } from "dockview-react";
import { CheckIcon, CopyIcon, CrosshairIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import type { DirEntry, ProjectFileStatus } from "@/api/project-files-model";
import { ProjectFileMenu } from "@/components/menus/ProjectFileMenu";
import { DetachedFileNode } from "@/components/panels/DetachedFileNode";
import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";
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
import {
  fileParentDir,
  findTreeRoot,
  isWithin,
  parentDir,
  pathName,
  statusColorClass,
} from "@/lib/project-file-helpers";
import { getActiveEditorFilePath } from "@/lib/reveal-in-explorer";
import { cn } from "@/lib/utils";
import { removeDirQueries } from "@/queries/query-helpers";
import { queryKeys } from "@/queries/query-keys";
import { useDiscardChangesMutation } from "@/queries/use-git-mutations";
import { useDetachedFilesQuery, useExternalFilesQuery } from "@/queries/use-repo-queries";
import { getQueryScope } from "@/queries/use-scope";
import { useEditorStateStore } from "@/store/editor-state";
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

  // --- Others section: open folders and individually opened files ---
  // The tree's roots are the worktree, then each Others folder (browsed and edited like the
  // worktree), then each Others file. `getTreeRoot` tells which folder tree a path belongs to;
  // Others files belong to none and are read-only in the tree.
  const { data: otherEntries } = useExternalFilesQuery();
  const folderRoots = useMemo(
    () => otherEntries?.filter((e) => e.isDir).map((e) => e.path) ?? [],
    [otherEntries],
  );
  const otherFilePaths = useMemo(
    () => new Set(otherEntries?.filter((e) => !e.isDir).map((e) => e.path)),
    [otherEntries],
  );
  const treeRoots = useMemo(
    () => (activeWorktreePath ? [activeWorktreePath, ...folderRoots] : folderRoots),
    [activeWorktreePath, folderRoots],
  );
  const getTreeRoot = useCallback((path: string) => findTreeRoot(path, treeRoots), [treeRoots]);
  const isTreeRoot = useCallback((path: string) => treeRoots.includes(path), [treeRoots]);
  const isOthersRoot = useCallback((path: string) => folderRoots.includes(path), [folderRoots]);
  const isOtherFile = useCallback((path: string) => otherFilePaths.has(path), [otherFilePaths]);
  /** Roots and Others files can't be renamed, moved, cut, copied or deleted from the tree. */
  const isFixedRow = useCallback(
    (path: string) => isTreeRoot(path) || isOtherFile(path),
    [isTreeRoot, isOtherFile],
  );

  const handleRemoveFromOthers = useCallback(
    async (path: string) => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return;
      try {
        await api.removeExternalFolder(wt, path);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to remove folder");
        return;
      }
      // Forget its tree like a collapse does, so reopening it later lists its current contents.
      treeRef.current?.clearSubtree(path);
      removeDirQueries(queryClient, path);
      const ui = getCurrentWorktreeUI().getState();
      ui.setExpandedProjectFolders(
        new Set([...ui.expandedProjectFolders].filter((p) => !isWithin(p, path))),
      );
      // Editors still open on its files keep receiving disk changes as individual Others files.
      const openPaths = [...useEditorStateStore.getState().files.keys()].filter((p) =>
        isWithin(p, path),
      );
      if (openPaths.length > 0) {
        wsClient.send({ type: "register_external_files", worktreePath: wt, filePaths: openPaths });
      }
    },
    [queryClient],
  );

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
      // Load every ancestor below the root of the tree that shows the path.
      const root = getTreeRoot(filePath);
      if (root && filePath !== root) {
        const segments = filePath.slice(root.length + 1).split("/");
        const ancestors: string[] = [root];
        for (let i = 0; i < segments.length - 1; i++) {
          ancestors.push(`${root}/${segments.slice(0, i + 1).join("/")}`);
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
    [queryClient, getTreeRoot],
  );

  // Reveal a folder opened via `loxel <folder>`, a terminal link, etc. once its tree lists it.
  // Right after a worktree switch the server is still creating the worktree's resources and its
  // listing fails, so keep the request until a reveal succeeds and retry as listings arrive.
  const pendingRevealFolder = useWorktreeUI((s) => s.pendingRevealFolder);
  useEffect(() => {
    if (!pendingRevealFolder || !getTreeRoot(pendingRevealFolder)) return;
    let done = false;
    const attempt = () => {
      revealFileInTree(pendingRevealFolder)
        .then(() => {
          if (done) return;
          done = true;
          treeRef.current?.expandPath(pendingRevealFolder);
          getCurrentWorktreeUI().getState().setPendingRevealFolder(null);
        })
        .catch(() => {});
    };
    attempt();
    const unsubscribe = onLoxelEvent("loxel-dir-changed", attempt);
    return () => {
      done = true;
      unsubscribe();
    };
  }, [pendingRevealFolder, getTreeRoot, revealFileInTree]);

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
    useFileClipboard(isDetachedPath, queryClient, activeWorktreePath, getTreeRoot);

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
  } = useProjectFileDrag(
    renamingPath,
    cutPath,
    scrollRef,
    startAutoScroll,
    stopAutoScroll,
    getTreeRoot,
  );

  // --- FilesTree: loadSubtree ---
  const rootNodes = useMemo<TreeNode[]>(
    () => [
      ...(activeWorktreePath ? [{ path: activeWorktreePath, name: rootName, isDir: true }] : []),
      ...(otherEntries ?? []).map((e) => ({ path: e.path, name: e.name, isDir: e.isDir })),
    ],
    [activeWorktreePath, rootName, otherEntries],
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
        // An Others folder may have changed while no worktree listing it was active, so its
        // directories are re-read instead of served from a cache last pushed to another worktree.
        staleTime: getTreeRoot(absDir) === wt ? Infinity : 0,
      });
      return entries.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir }));
    },
    [queryClient, getTreeRoot],
  );

  // --- FilesTree: rendering callbacks ---

  const getEntryStatus = useCallback(
    (path: string): ProjectFileStatus | undefined => {
      if (isTreeRoot(path)) return undefined;
      const dir = fileParentDir(path, activeWorktreePath);
      const { activeProjectPath } = getQueryScope();
      const absDir = toAbsoluteDir(dir, activeWorktreePath);
      const entries = queryClient.getQueryData<DirEntry[]>(
        queryKeys.dirContents(activeProjectPath, absDir),
      );
      const name = pathName(path);
      return entries?.find((e) => e.name === name)?.status;
    },
    [queryClient, activeWorktreePath, isTreeRoot],
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

      // An individually opened Others file
      if (isOtherFile(node.path)) {
        return (
          <span className="text-muted-foreground min-w-0 flex-1 truncate italic">{node.name}</span>
        );
      }

      // Root node (the worktree or an Others folder): bold
      if (node.isDir && isTreeRoot(node.path)) {
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
    [renamingPath, handleFinishRename, handleCancelRename, getEntryStatus, isTreeRoot, isOtherFile],
  );

  // Others rows show their full path on hover, since their names alone can be ambiguous.
  const getTreeRowProps = useCallback(
    (node: TreeNode) =>
      isOthersRoot(node.path) || isOtherFile(node.path)
        ? { ...getRowProps(node), title: node.path }
        : getRowProps(node),
    [getRowProps, isOthersRoot, isOtherFile],
  );

  // The Others section starts at the first root after the worktree's own.
  const renderRootHeader = useCallback(
    (_node: TreeNode, index: number) =>
      index === 1 && (
        <>
          <div className="border-border mx-2 my-1.5 border-t" />
          <div className="px-3 py-1">
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
              Others
            </span>
          </div>
        </>
      ),
    [],
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
        const isFocusedFixed = isFixedRow(focusedPath);
        if (treeActionId === "tree.open") {
          e.preventDefault();
          if (focused.hasAttribute("data-tree-dir")) {
            treeRef.current?.togglePath(focusedPath);
          } else {
            dispatchOpenFile(focusedPath);
          }
          return;
        }
        if (isFocusedFixed) return;
        e.preventDefault();
        handleStartRename(focusedPath);
        return;
      }

      const selected = getCurrentWorktreeUI().getState().selectedProjectFile;
      if (!selected) return;

      const isDetached = isDetachedPath(selected);
      const isFixed = isFixedRow(selected);

      if (isMeta && e.key === "x") {
        if (isFixed) return;
        e.preventDefault();
        handleCut(selected);
        return;
      }
      if (isMeta && e.key === "c") {
        if (isFixed) return;
        e.preventDefault();
        handleCopyFile(selected);
        return;
      }
      if (isMeta && e.key === "v" && clipboard) {
        if (isDetached || isOtherFile(selected)) return;
        e.preventDefault();
        handlePaste(resolveTargetDir(selected));
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (isFixed) return;
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
      isFixedRow,
      isOtherFile,
    ],
  );

  // --- Derived values for context menu and delete dialog ---
  const ctxIsDraft = contextMenu ? isDetachedPath(contextMenu.path) : false;
  const ctxIsRoot = contextMenu ? isTreeRoot(contextMenu.path) : false;
  const ctxIsFixed = contextMenu ? isFixedRow(contextMenu.path) : false;
  const ctxIsOthersRoot = contextMenu ? isOthersRoot(contextMenu.path) : false;
  // An individually opened Others file is outside every tree: its menu only offers Open In.
  const ctxIsOtherFile = contextMenu ? isOtherFile(contextMenu.path) : false;
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
          renderRootHeader={renderRootHeader}
          getRowProps={getTreeRowProps}
          getRowClassName={getRowClassName}
          isPanelActive={isPanelActive}
          compactRoot={false}
          disableBuiltinKeyNav
        />
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
            !ctxIsDraft && !ctxIsOtherFile
              ? () => handleNewFile(parentDir(contextMenu.path, contextMenu.isDir))
              : undefined
          }
          onNewDir={
            !ctxIsDraft && !ctxIsOtherFile
              ? () => handleNewDir(parentDir(contextMenu.path, contextMenu.isDir))
              : undefined
          }
          onRename={!ctxIsFixed ? () => handleStartRename(contextMenu.path) : undefined}
          onDelete={
            !ctxIsFixed ? () => handleRequestDelete(contextMenu.path, contextMenu.isDir) : undefined
          }
          onCut={!ctxIsFixed ? () => handleCut(contextMenu.path) : undefined}
          onCopy={!ctxIsFixed ? () => handleCopyFile(contextMenu.path) : undefined}
          onPaste={
            !ctxIsDraft && !ctxIsOtherFile
              ? () =>
                  handlePaste(
                    ctxIsRoot ? contextMenu.path : parentDir(contextMenu.path, contextMenu.isDir),
                  )
              : undefined
          }
          onGitRestore={
            ctxIsModified
              ? () => handleRequestRestore(contextMenu.path, contextMenu.isDir)
              : undefined
          }
          onRemoveFromOthers={
            ctxIsOthersRoot ? () => handleRemoveFromOthers(contextMenu.path) : undefined
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
