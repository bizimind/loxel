import type { WorktreeRef } from "@/api/worktree-ref";
import { getPanelServer, getPanelWorktree } from "@/components/dockview/panel-context";
import { type EditorKey, fileEditorKey } from "@/store/editor-state";
import { getCenterPanelDef } from "@/store/panel-config";
import { getCenterApi, showPanel } from "@/store/tools-bar";
import { getCurrentWorktreeUI } from "@/store/worktree-ui";

/** Panel types whose ID encodes a file path after the prefix. */
const FILE_PANEL_TYPES = new Set(["editor", "codeEditor", "excalidraw", "media"]);

/** The file an editor panel shows and the worktree the panel belongs to. */
export interface ActiveEditorFile {
  filePath: string;
  /** The panel's worktree; null for Home's panels. */
  worktree: WorktreeRef | null;
  /** The file's tab key, on the panel's server, which keys what the tab publishes. */
  editorKey: EditorKey;
}

/**
 * The file of the currently active center panel, if it's a file-based editor, with the panel's
 * own worktree: right after a worktree switch the outgoing center still holds the active panel.
 */
export function getActiveEditorFile(): ActiveEditorFile | null {
  const active = getCenterApi()?.activePanel;
  if (!active) return null;
  const def = getCenterPanelDef(active.id);
  if (!def || !FILE_PANEL_TYPES.has(def.type)) return null;
  const filePath = active.id.slice(def.idPrefix.length);
  return {
    filePath,
    worktree: getPanelWorktree(active),
    editorKey: fileEditorKey(getPanelServer(active), filePath),
  };
}

/** Extract the file path from the currently active center panel, if it's a file-based editor. */
export function getActiveEditorFilePath(): string | null {
  return getActiveEditorFile()?.filePath ?? null;
}

/**
 * Show the project files panel and select a path of the active worktree in it, loading and
 * expanding its ancestors. The reveal waits until the panel is mounted and lists the path.
 */
export function revealInProjectExplorer(path: string): void {
  showPanel("projectFiles");
  getCurrentWorktreeUI().getState().setPendingReveal({ path, expand: false });
}
