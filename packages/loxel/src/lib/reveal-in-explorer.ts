import { getCenterPanelDef } from "@/store/panel-config";
import { getCenterApi } from "@/store/tools-bar";

/** Panel types whose ID encodes a file path after the prefix. */
const FILE_PANEL_TYPES = new Set(["editor", "codeEditor", "excalidraw", "media"]);

/** Extract the file path from the currently active center panel, if it's a file-based editor. */
export function getActiveEditorFilePath(): string | null {
  const active = getCenterApi()?.activePanel;
  if (!active) return null;
  const def = getCenterPanelDef(active.id);
  if (!def || !FILE_PANEL_TYPES.has(def.type)) return null;
  return active.id.slice(def.idPrefix.length);
}
