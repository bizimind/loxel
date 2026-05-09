import type { DirEntry } from "@/api/project-files-model";

import { TreeRow } from "@/components/tree";
import { dispatchOpenFile } from "@/lib/open-file";
import { useWorktreeUI } from "@/store/worktree-ui";

export function ExternalFileNode({
  entry,
  isPanelActive,
}: {
  entry: DirEntry;
  isPanelActive: boolean;
}) {
  const filePath = entry.path;
  const selectedFile = useWorktreeUI((s) => s.selectedProjectFile);
  const setSelectedFile = useWorktreeUI((s) => s.setSelectedProjectFile);
  const isSelected = filePath === selectedFile;

  return (
    <TreeRow
      path={filePath}
      name={entry.name}
      depth={0}
      isDir={false}
      isSelected={isSelected}
      isPanelActive={isPanelActive}
      label={
        <span className="text-muted-foreground min-w-0 flex-1 truncate italic">{entry.name}</span>
      }
      buttonProps={{ title: filePath }}
      onClick={() => setSelectedFile(filePath)}
      onDoubleClick={() => dispatchOpenFile(filePath)}
    />
  );
}
