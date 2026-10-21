/**
 * Registry of per-panel "start renaming my tab" handlers, keyed by dockview panel id.
 *
 * Renameable tabs (those given `onRename`) register here so the `panel.rename` action can put the
 * active center tab into inline rename from the keyboard or the command palette.
 */

import { getCenterApi } from "@/store/tools-bar";

const handlers = new Map<string, () => void>();

/** Register `startRename` for `panelId`. Returns an unregister function. */
export function registerTabRename(panelId: string, startRename: () => void): () => void {
  handlers.set(panelId, startRename);
  return () => {
    if (handlers.get(panelId) === startRename) handlers.delete(panelId);
  };
}

function activeCenterPanelId(): string | undefined {
  return getCenterApi()?.activePanel?.id;
}

/**
 * Whether the center's active tab can be renamed. Changes here don't re-send the webview keystroke
 * interception: a focused browser panel is the active tab, which is never renameable, so a stale
 * set can only leave the key with the page.
 */
export function canRenameActiveTab(): boolean {
  const panelId = activeCenterPanelId();
  return panelId !== undefined && handlers.has(panelId);
}

/** Put the center's active tab into inline rename, when it is renameable. */
export function renameActiveTab(): void {
  const panelId = activeCenterPanelId();
  if (panelId !== undefined) handlers.get(panelId)?.();
}
