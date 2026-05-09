/**
 * Typed event system for loxel custom events.
 *
 * Provides type-safe dispatch and listener helpers to replace
 * raw `new CustomEvent()` and `as CustomEvent<T>` casts.
 */
import type { SplitPosition } from "@/components/dockview/default-layout";

/** Detail shapes for all loxel custom events. */
export interface LoxelEventMap {
  "loxel-create-agent": { split?: SplitPosition };
  "loxel-create-terminal": { split?: SplitPosition };
  "loxel-create-editor": { split?: SplitPosition };
  "loxel-create-drawing": { split?: SplitPosition };
  "loxel-create-browser": { url?: string; split?: SplitPosition };
  "loxel-create-code-editor": { ext?: string; split?: SplitPosition };
  "loxel-create-editor-with-content": { content: string; title: string };
  "loxel-open-agent-devtools": { sessionId: string };
  "loxel-open-code-editor": { filePath: string; line?: number; column?: number };
  "loxel-open-markdown-editor": { filePath: string; line?: number; column?: number };
  "loxel-open-drawing-editor": { filePath: string };
  "loxel-open-media-viewer": { filePath: string };
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
