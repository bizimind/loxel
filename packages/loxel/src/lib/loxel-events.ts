/**
 * Typed event system for loxel custom events.
 *
 * Provides type-safe dispatch and listener helpers to replace
 * raw `new CustomEvent()` and `as CustomEvent<T>` casts.
 */
import type { PanelOpenOptions, PanelPlacement } from "@/api/panel-placement-model";
import type { ServerId, WorktreeRef } from "@/api/worktree-ref";
import type { CreateTerminalOptions, PatchDiffParams } from "@/lib/panel-creators";

/** A file to open in its panel; `placement` moves an already open tab there too. */
type OpenFileDetail = { filePath: string } & PanelOpenOptions;

/** Detail shapes for all loxel custom events. */
export interface LoxelEventMap {
  "loxel-create-terminal": CreateTerminalOptions;
  "loxel-create-editor": { placement?: PanelPlacement };
  "loxel-create-drawing": { placement?: PanelPlacement };
  "loxel-create-browser": { url?: string; incognito?: boolean } & PanelOpenOptions;
  "loxel-create-code-editor": { ext?: string; placement?: PanelPlacement };
  "loxel-create-editor-with-content": { content: string; title: string };
  "loxel-open-code-editor": OpenFileDetail & { line?: number; column?: number };
  "loxel-open-markdown-editor": OpenFileDetail & { line?: number; column?: number };
  "loxel-open-virtual-document": { uri: string; line?: number; column?: number };
  "loxel-open-drawing-editor": OpenFileDetail;
  "loxel-open-media-viewer": OpenFileDetail;
  "loxel-open-diff": undefined;
  /** Splitting a patch's diff panel sends no patch: the panel it starts from is duplicated. */
  "loxel-open-patch-diff": PatchDiffParams | { placement?: PanelPlacement };
  /** Splitting a compare panel sends no paths: the comparison it starts from is duplicated. */
  "loxel-compare-files": { oldPath: string; newPath: string } | { placement?: PanelPlacement };
  "loxel-open-localdb": undefined;
  /** A file or folder moved on `server`, whose tabs follow it (absolute paths there). */
  "loxel-file-moved": { server: ServerId; oldPath: string; newPath: string };
  /** A file or folder deleted on `server`, whose tabs close (an absolute path there). */
  "loxel-file-deleted": { server: ServerId; filePath: string };
  "loxel-dir-changed": { dir: string };
  /** The server confirmed a worktree subscription; listings shown for it may have missed changes. */
  "loxel-worktree-files-resynced": { wt: WorktreeRef };
  /** A toolchain of `wt` changed (`changedMessage`, one of `toolchainStatuses`'), on any server. */
  "loxel-toolchain-changed": { wt: WorktreeRef; changedMessage: string };
  /**
   * A worktree left this window's lists (removed or moved, anywhere, or its project removed from
   * Loxel): nothing of it is served any more. `discarded`: the user removed it, or deleted its
   * project, in Loxel, giving up what it held.
   */
  "loxel-worktree-gone": { wt: WorktreeRef; discarded: boolean };
  "loxel-reveal-in-explorer": { filePath: string };
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
