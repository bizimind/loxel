import type { DockviewPanelApi } from "dockview-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { ChangesFileMenu } from "@/components/menus/ChangesFileMenu";
import { BranchCommitDropdown } from "@/components/panels/BranchCommitDropdown";
import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";
import { type TreeNode, FilesTree } from "@/components/tree";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { showToast } from "@/components/ui/toast";
import { usePanelActive } from "@/hooks/usePanelActive";
import { dispatchOpenFile } from "@/lib/open-file";
import { isWithin, pathName } from "@/lib/project-file-helpers";
import { revealInProjectExplorer } from "@/lib/reveal-in-explorer";
import { cn } from "@/lib/utils";
import { useRevertToHeadMutation } from "@/queries/use-git-mutations";
import { useDiffQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

// --- Tree building ---

type BuildNode = Omit<TreeNode, "children"> & { children: BuildNode[] };

function buildFileTree(files: FileDiff[]): TreeNode[] {
  const root: BuildNode = { name: "", path: "", isDir: true, children: [] };

  for (const file of files) {
    const filePath = file.newPath || file.oldPath;
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const name = parts[i];
      if (!name) continue;
      const path = parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === name);
      if (!child) {
        child = { name, path, isDir: !isLast, children: [] };
        current.children.push(child);
      }
      current = child;
    }
  }

  function sortTree(nodes: BuildNode[]): BuildNode[] {
    return nodes
      .map((node) => ({ ...node, children: sortTree(node.children) }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return compactTree(sortTree(root.children));
}

function compactTree(nodes: TreeNode[]): TreeNode[] {
  // oxlint-disable-next-line array-callback-return -- all paths return; false positive with while loop
  return nodes.map((node) => {
    if (!node.isDir) return node;
    let name = node.name;
    let current = node;
    let onlyChild = current.children?.[0];
    while (current.children?.length === 1 && onlyChild && onlyChild.isDir) {
      current = onlyChild;
      name = name + "/" + current.name;
      onlyChild = current.children?.[0];
    }
    return {
      ...current,
      name,
      children: current.children ? compactTree(current.children) : undefined,
    };
  });
}

interface DiscardTarget {
  worktree: string;
  path: string;
  isDir: boolean;
  files: FileDiff[];
}

/** Every path a discard of `files` must revert: both sides of a rename (a copy's source stays). */
function discardPaths(files: FileDiff[]): string[] {
  return [
    ...new Set(
      files.flatMap((f) => (f.status === "renamed" ? [f.oldPath, f.newPath] : [fileDiffPath(f)])),
    ),
  ];
}

function discardDescription(target: DiscardTarget, activeWorktreePath: string | null): string {
  const where =
    target.worktree === activeWorktreePath ? "" : ` in worktree "${pathName(target.worktree)}"`;
  const file = target.files[0];
  let question: string;
  if (target.isDir) {
    const count = target.files.length;
    const deletes = target.files.some((f) => f.status === "added" || f.status === "copied");
    question = `Discard local changes to ${count} ${count === 1 ? "file" : "files"} in "${target.path}"${where}?${deletes ? " New files will be deleted." : ""}`;
  } else if (file?.status === "added" || file?.status === "copied") {
    question = `Discard "${target.path}"${where}? It is a new file and will be deleted.`;
  } else if (file?.status === "renamed") {
    question = `Discard the rename of "${file.oldPath}" to "${target.path}"${where}? "${file.oldPath}" will be restored and "${target.path}" deleted.`;
  } else {
    question = `Discard local changes to "${target.path}"${where}?`;
  }
  return `${question} This cannot be undone.`;
}

// --- Component ---

export function FileTreePanel({ panelApi }: { panelApi?: DockviewPanelApi }) {
  const diffSource = useRepositoryStore((s) => s.diffSource);
  const { data: diff } = useDiffQuery(diffSource);
  const selectedFile = useWorktreeUI((s) => s.selectedDiffFile);
  const setSelectedFile = useWorktreeUI((s) => s.setSelectedDiffFile);
  const isPanelActive = usePanelActive(panelApi);

  const files = diff?.files ?? [];

  const fileTree = useMemo(() => buildFileTree(files), [files]);

  const fileMap = useMemo(() => {
    const map = new Map<string, FileDiff>();
    for (const f of files) map.set(fileDiffPath(f), f);
    return map;
  }, [files]);

  // Update tab title with file count
  useEffect(() => {
    panelApi?.setTitle(`Files (${files.length})`);
  }, [panelApi, files.length]);

  // Auto-select first file when selection is invalid
  useEffect(() => {
    if (!selectedFile || !files.some((f) => fileDiffPath(f) === selectedFile)) {
      const first = files[0];
      setSelectedFile(first ? fileDiffPath(first) : null);
    }
  }, [files, selectedFile, setSelectedFile]);

  const openDiffPanel = useCallback(() => {
    window.dispatchEvent(new CustomEvent("loxel-open-diff"));
  }, []);

  // --- Context menu ---
  // Entry paths are relative to the repository root. They are on disk in the worktree whose local
  // changes are shown, and otherwise (commits) in the active worktree's checkout.
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const filesRoot = diffSource?.worktree ?? activeWorktreePath;
  const showsLocalChanges = diffSource?.type === "uncommitted" && !diffSource.base;
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    path: string;
    isDir: boolean;
  } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, path, isDir });
  }, []);

  // --- Discard (local changes only) ---
  const revertMutation = useRevertToHeadMutation();
  const [discardTarget, setDiscardTarget] = useState<DiscardTarget | null>(null);

  const handleRequestDiscard = useCallback(
    (worktree: string, path: string, isDir: boolean) => {
      const targetFiles = isDir
        ? files.filter((f) => isWithin(fileDiffPath(f), path))
        : files.filter((f) => fileDiffPath(f) === path);
      if (targetFiles.length === 0) return;
      setDiscardTarget({ worktree, path, isDir, files: targetFiles });
    },
    [files],
  );

  const handleConfirmDiscard = useCallback(async () => {
    if (!discardTarget) return;
    setDiscardTarget(null);
    try {
      await revertMutation.mutateAsync({
        worktree: discardTarget.worktree,
        files: discardPaths(discardTarget.files),
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to discard changes");
    }
  }, [discardTarget, revertMutation]);

  // The selected file is the one the diff viewer shows. Moving focus (arrow keys, type-ahead)
  // only moves the tree's cursor: clicking a file selects it, and Enter or double-click selects
  // it and opens the diff viewer.
  const handleFileClick = useCallback(
    (path: string) => {
      if (fileMap.has(path)) setSelectedFile(path);
    },
    [fileMap, setSelectedFile],
  );

  const handleOpen = useCallback(
    (path: string) => {
      if (!fileMap.has(path)) return;
      setSelectedFile(path);
      openDiffPanel();
    },
    [fileMap, setSelectedFile, openDiffPanel],
  );

  const renderTrailing = useCallback(
    (node: TreeNode) => {
      const file = fileMap.get(node.path);
      if (!file) return null;
      return (
        <span className="text-muted-foreground flex shrink-0 gap-1.5 text-[10px]">
          {file.additions > 0 && <span className="text-diff-add-text">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-diff-del-text">-{file.deletions}</span>}
        </span>
      );
    },
    [fileMap],
  );

  const getLabelClassName = useCallback(
    (node: TreeNode) => {
      const file = fileMap.get(node.path);
      if (!file) return undefined;
      return cn(
        file.status === "added" && "text-diff-add-text",
        file.status === "deleted" && "text-muted-foreground line-through",
        file.status !== "added" && file.status !== "deleted" && "text-diff-modify-text",
      );
    },
    [fileMap],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DraggablePanelHeader panelId="changes" className="flex items-center gap-1.5">
        <h2 className="text-foreground shrink-0 text-sm font-medium">
          Changes{files.length > 0 ? ` (${files.length})` : ""}
        </h2>
        <div className="min-w-0 flex-1" />
        <BranchCommitDropdown />
      </DraggablePanelHeader>

      {files.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          No files
        </div>
      ) : (
        <FilesTree
          nodes={fileTree}
          autoExpandDirs
          focusedPath={selectedFile}
          activePath={selectedFile}
          isPanelActive={isPanelActive}
          onOpen={handleOpen}
          onFileClick={handleFileClick}
          onContextMenu={handleContextMenu}
          renderTrailing={renderTrailing}
          labelClassName={getLabelClassName}
          className="flex-1 scrollbar-thin overflow-y-auto py-1"
        />
      )}

      {contextMenu && filesRoot && (
        <ChangesFileMenu
          position={contextMenu.position}
          path={contextMenu.path}
          absolutePath={`${filesRoot}/${contextMenu.path}`}
          isDir={contextMenu.isDir}
          onClose={() => setContextMenu(null)}
          onOpenDiff={contextMenu.isDir ? undefined : () => handleOpen(contextMenu.path)}
          // The editor and the project explorer show the active worktree only.
          onOpenFile={
            !contextMenu.isDir && filesRoot === activeWorktreePath
              ? () => dispatchOpenFile(`${filesRoot}/${contextMenu.path}`)
              : undefined
          }
          onRevealInExplorer={
            filesRoot === activeWorktreePath
              ? () => revealInProjectExplorer(`${filesRoot}/${contextMenu.path}`)
              : undefined
          }
          onDiscard={
            showsLocalChanges
              ? () => handleRequestDiscard(filesRoot, contextMenu.path, contextMenu.isDir)
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={discardTarget !== null}
        title="Discard Changes"
        description={discardTarget ? discardDescription(discardTarget, activeWorktreePath) : ""}
        confirmLabel="Discard"
        destructive
        onConfirm={handleConfirmDiscard}
        onCancel={() => setDiscardTarget(null)}
      />
    </div>
  );
}
