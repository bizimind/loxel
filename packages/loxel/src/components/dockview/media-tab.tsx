import type { IDockviewPanelHeaderProps } from "dockview-react";
import { ImageIcon } from "lucide-react";

import { useFileTabRename } from "@/hooks/useFileTabRename";
import { getDisplayFilename } from "@/lib/detached-path";

import { FileContextMenuItems, Tab } from "./tab";

export function MediaTab(
  props: IDockviewPanelHeaderProps<{ filePath: string; worktreePath?: string }>,
) {
  const filePath = props.params.filePath;
  const filename = getDisplayFilename(filePath);
  const handleRename = useFileTabRename(filePath);

  return (
    <Tab
      api={props.api}
      icon={<ImageIcon className="size-3.5 shrink-0" />}
      title={filename}
      onRename={handleRename}
      selectBaseName
      contextMenuItems={
        <FileContextMenuItems
          filename={filename}
          filePath={filePath}
          worktreePath={props.params.worktreePath}
        />
      }
    />
  );
}
