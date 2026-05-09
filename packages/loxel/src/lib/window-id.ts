import { STORAGE_PREFIX } from "./env";

/**
 * Per-window identity. Source of truth depends on the runtime:
 * - Electron: assigned by main process at BrowserWindow creation, passed via
 *   `additionalArguments`, exposed by preload as `window.loxelWindow.windowId`.
 *   Stable across renderer reloads (Cmd+R), unique per BrowserWindow.
 * - Web/dev (no Electron): generated once and persisted in localStorage so it
 *   survives page reloads. There's only ever one logical "window" in this mode
 *   (browser tabs of the same dev origin would share the ID — an inherent
 *   limitation of single-origin dev).
 */
function getWindowId(): string {
  // Electron: preload always exposes loxelWindow. If we're in Electron but the
  // ID is missing, fail fast — falling back to localStorage would silently
  // share an ID across BrowserWindows and break per-window isolation.
  if (window.loxelWindow) {
    if (!window.loxelWindow.windowId) {
      throw new Error("loxelWindow.windowId missing — preload args parse failed");
    }
    return window.loxelWindow.windowId;
  }

  const KEY = `${STORAGE_PREFIX}-window-id`;
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export const WINDOW_ID = getWindowId();

/**
 * Whether this window was the only loxel window alive at creation time.
 * - Electron: provided by main; false when another window was already open.
 * - Web/dev: always true (single logical window).
 *
 * Used by the layout system to decide whether to restore the canonical
 * "last closed window" layout (true) or start with the default (false).
 */
export const IS_FIRST_WINDOW = window.loxelWindow ? window.loxelWindow.isFirstWindow : true;
