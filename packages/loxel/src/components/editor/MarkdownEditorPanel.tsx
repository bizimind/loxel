/**
 * Dockview wrapper for the MarkdownEditor component.
 */
import type { IDockviewPanelProps } from "dockview-react";

import { PanelWorktreeProvider } from "@/components/dockview/panel-context";

import { MarkdownEditor } from "./MarkdownEditor";

export function MarkdownEditorPanelComponent(
  props: IDockviewPanelProps<{
    filePath: string;
    worktreePath?: string;
    line?: number;
    column?: number;
    movedFrom?: string;
  }>,
) {
  return (
    <PanelWorktreeProvider worktreePath={props.params.worktreePath}>
      <MarkdownEditor
        filePath={props.params.filePath}
        line={props.params.line}
        column={props.params.column}
        movedFrom={props.params.movedFrom}
        onClose={() => props.api.close()}
        onCreateNew={() => {
          window.dispatchEvent(new CustomEvent("loxel-create-editor"));
        }}
        panelApi={props.api}
      />
    </PanelWorktreeProvider>
  );
}
