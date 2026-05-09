/**
 * Dockview wrapper for the MarkdownEditor component.
 */
import type { IDockviewPanelProps } from "dockview-react";

import { PanelContext } from "@/components/dockview/panel-context";

import { MarkdownEditor } from "./MarkdownEditor";

export function MarkdownEditorPanelComponent(
  props: IDockviewPanelProps<{
    filePath: string;
    worktreePath?: string;
    line?: number;
    column?: number;
  }>,
) {
  return (
    <PanelContext.Provider value={{ worktreePath: props.params.worktreePath ?? null }}>
      <MarkdownEditor
        filePath={props.params.filePath}
        line={props.params.line}
        column={props.params.column}
        onClose={() => props.api.close()}
        onCreateNew={() => {
          window.dispatchEvent(new CustomEvent("loxel-create-editor"));
        }}
        panelApi={props.api}
      />
    </PanelContext.Provider>
  );
}
