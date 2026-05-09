import type { DirEntry } from "@/api/project-files-model";

import { InlineRenameInput, TreeRow } from "@/components/tree";
import { DETACHED_FILE_DRAG_TYPE, setRowDragImage } from "@/hooks/useProjectFileDrag";
import { dispatchOpenFile } from "@/lib/open-file";
import { useWorktreeUI } from "@/store/worktree-ui";

export function DetachedFileNode({
  entry,
  isPanelActive,
  onContextMenu,
  renamingPath,
  onFinishRename,
  onCancelRename,
}: {
  entry: DirEntry;
  isPanelActive: boolean;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  renamingPath: string | null;
  onFinishRename: (path: string, newName: string) => Promise<void>;
  onCancelRename: () => void;
}) {
  const filePath = entry.path;
  const selectedFile = useWorktreeUI((s) => s.selectedProjectFile);
  const setSelectedFile = useWorktreeUI((s) => s.setSelectedProjectFile);
  const isSelected = filePath === selectedFile;
  const isRenaming = renamingPath === filePath;

  return (
    <TreeRow
      path={filePath}
      name={entry.name}
      depth={0}
      isDir={false}
      isSelected={isSelected}
      isPanelActive={isPanelActive}
      label={
        isRenaming ? (
          <InlineRenameInput
            currentName={entry.name}
            isDir={false}
            onFinish={(newName) => onFinishRename(filePath, newName)}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate italic">{entry.name}</span>
        )
      }
      buttonProps={{
        draggable: !isRenaming,
        onDragStart: (e: React.DragEvent<HTMLButtonElement>) => {
          e.dataTransfer.setData(DETACHED_FILE_DRAG_TYPE, entry.path);
          e.dataTransfer.effectAllowed = "move";
          setRowDragImage(e);
        },
      }}
      onClick={() => setSelectedFile(filePath)}
      onDoubleClick={() => {
        if (!isRenaming) dispatchOpenFile(filePath);
      }}
      onContextMenu={(e) => onContextMenu(e, filePath, false)}
    />
  );
}
