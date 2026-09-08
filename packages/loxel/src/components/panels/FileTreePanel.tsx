import type { DockviewPanelApi } from "dockview-react";
import { useCallback, useEffect, useMemo } from "react";

import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { BranchCommitDropdown } from "@/components/panels/BranchCommitDropdown";
import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";
import { type TreeNode, FilesTree } from "@/components/tree";
import { usePanelActive } from "@/hooks/usePanelActive";
import { cn } from "@/lib/utils";
import { useDiffQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeUI } from "@/store/worktree-ui";

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

  const handleOpen = useCallback(() => {
    window.dispatchEvent(new CustomEvent("loxel-open-diff"));
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      if (!fileMap.has(path)) return;
      setSelectedFile(path);
    },
    [fileMap, setSelectedFile],
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
          onSelect={handleSelect}
          renderTrailing={renderTrailing}
          labelClassName={getLabelClassName}
          className="flex-1 scrollbar-thin overflow-y-auto py-1"
        />
      )}
    </div>
  );
}
