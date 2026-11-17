import type { IDockviewPanelHeaderProps } from "dockview-react";

import { useFileTabRename } from "@/hooks/useFileTabRename";
import { getDisplayFilename } from "@/lib/detached-path";
import { useEditorStateStore } from "@/store/editor-state";

import { DELETED_TAB_TITLE_CLASS, DivergedDot, FileContextMenuItems, QueuedDot, Tab } from "./tab";

interface EditorTabProps {
  props: IDockviewPanelHeaderProps<{ filePath: string; worktreePath?: string }>;
  icon: React.ReactNode;
}

/**
 * Shared dockview tab for file-backed editor panels (code, markdown, excalidraw).
 * Shows an icon, filename, diverged or save-queued indicator, deleted-from-disk styling, and close
 * button.
 */
export function EditorTab({ props, icon }: EditorTabProps) {
  const filePath = props.params.filePath;
  const filename = getDisplayFilename(filePath);
  const handleRename = useFileTabRename(filePath);
  const isDiverged = useEditorStateStore((s) => s.files.get(filePath)?.state === "diverged");
  const isDeleted = useEditorStateStore((s) => s.files.get(filePath)?.deleted ?? false);
  const isQueued = useEditorStateStore((s) => s.files.get(filePath)?.queued ?? false);

  let leading: React.ReactNode = null;
  if (isDiverged) leading = <DivergedDot title="File changed on disk" />;
  else if (isQueued) leading = <QueuedDot title="Not saved yet: waiting for the Loxel server" />;

  return (
    <Tab
      api={props.api}
      icon={icon}
      title={filename}
      onRename={handleRename}
      selectBaseName
      leading={leading}
      titleClassName={isDeleted ? DELETED_TAB_TITLE_CLASS : undefined}
      titleTooltip={isDeleted ? "File deleted from disk" : undefined}
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
