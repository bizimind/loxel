import type { IDockviewPanelHeaderProps } from "dockview-react";

import { useFileTabRename } from "@/hooks/useFileTabRename";
import { getDisplayFilename } from "@/lib/detached-path";
import { useEditorStateStore } from "@/store/editor-state";

import { FileContextMenuItems, Tab } from "./tab";

interface EditorTabProps {
  props: IDockviewPanelHeaderProps<{ filePath: string; worktreePath?: string }>;
  icon: React.ReactNode;
}

/**
 * Shared dockview tab for file-backed editor panels (code, markdown, excalidraw).
 * Shows an icon, filename, diverged indicator, and close button.
 */
export function EditorTab({ props, icon }: EditorTabProps) {
  const filePath = props.params.filePath;
  const filename = getDisplayFilename(filePath);
  const handleRename = useFileTabRename(filePath);
  const isDiverged = useEditorStateStore((s) => s.files.get(filePath)?.state === "diverged");

  const leading = isDiverged ? (
    <span
      className="inline-block size-2 shrink-0 rounded-full bg-yellow-500"
      title="File changed on disk"
    />
  ) : null;

  return (
    <Tab
      api={props.api}
      icon={icon}
      title={filename}
      onRename={handleRename}
      selectBaseName
      leading={leading}
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
