/**
 * Typed event system for loxel custom events.
 *
 * Provides type-safe dispatch and listener helpers to replace
 * raw `new CustomEvent()` and `as CustomEvent<T>` casts.
 */
import type { PanelPlacement } from "@/api/panel-placement-model";
import type { CreateTerminalOptions } from "@/lib/panel-creators";

/** A file to open in its panel; `placement` moves an already open tab there too. */
interface OpenFileDetail {
  filePath: string;
  placement?: PanelPlacement;
}

/** Detail shapes for all loxel custom events. */
export interface LoxelEventMap {
  "loxel-create-agent": { placement?: PanelPlacement };
  "loxel-create-terminal": CreateTerminalOptions;
  "loxel-create-editor": { placement?: PanelPlacement };
  "loxel-create-drawing": { placement?: PanelPlacement };
  "loxel-create-browser": { url?: string; placement?: PanelPlacement };
  "loxel-create-code-editor": { ext?: string; placement?: PanelPlacement };
  "loxel-create-editor-with-content": { content: string; title: string };
  "loxel-open-agent-devtools": { sessionId: string };
  "loxel-open-code-editor": OpenFileDetail & { line?: number; column?: number };
  "loxel-open-markdown-editor": OpenFileDetail & { line?: number; column?: number };
  "loxel-open-drawing-editor": OpenFileDetail;
  "loxel-open-media-viewer": OpenFileDetail;
  "loxel-open-diff": undefined;
  "loxel-open-localdb": undefined;
  "loxel-file-moved": { oldPath: string; newPath: string };
  "loxel-file-deleted": { filePath: string };
  "loxel-dir-changed": { dir: string };
  "loxel-reveal-in-explorer": { filePath: string };
  "loxel-localdb-changed": {
    projectPath: string;
    tableName?: string;
    tableId?: number;
    scope: "schema" | "data" | "views";
  };
}

/** Type-safe event dispatch. */
export function dispatchLoxelEvent<K extends keyof LoxelEventMap>(
  name: K,
  ...args: LoxelEventMap[K] extends undefined ? [] : [detail: LoxelEventMap[K]]
): void {
  const detail = args[0];
  window.dispatchEvent(detail !== undefined ? new CustomEvent(name, { detail }) : new Event(name));
}

/** Type-safe event listener. Returns a cleanup function for use in useEffect. */
export function onLoxelEvent<K extends keyof LoxelEventMap>(
  name: K,
  handler: (detail: LoxelEventMap[K]) => void,
): () => void {
  const listener = (e: Event) => {
    if (e instanceof CustomEvent) {
      handler(e.detail as LoxelEventMap[K]);
    } else {
      handler(undefined as LoxelEventMap[K]);
    }
  };
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
