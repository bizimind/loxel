import type { IDockviewPanelHeaderProps } from "dockview-react";

import { getDisplayFilename } from "@/lib/detached-path";
import { FileTypeIcon } from "@/lib/file-icons";

import { EditorTab } from "./editor-tab";

export function CodeEditorTab(props: IDockviewPanelHeaderProps<{ filePath: string }>) {
  const filename = getDisplayFilename(props.params.filePath);
  return (
    <EditorTab
      props={props}
      icon={<FileTypeIcon filename={filename} className="size-3.5 shrink-0" />}
    />
  );
}
