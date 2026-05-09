import type { IDockviewPanelHeaderProps } from "dockview-react";

import { PencilRulerIcon } from "lucide-react";

import { EditorTab } from "./editor-tab";

export function ExcalidrawEditorTab(props: IDockviewPanelHeaderProps<{ filePath: string }>) {
  return <EditorTab props={props} icon={<PencilRulerIcon className="size-3.5 shrink-0" />} />;
}
