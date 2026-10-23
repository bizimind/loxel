/**
 * Registry of per-panel "start renaming my tab" handlers, keyed by dockview panel id.
 *
 * Renameable tabs (those given `onRename`) register here so the `panel.rename` action can put the
 * active center tab into inline rename from the keyboard or the command palette.
 */

import { isFocusInCenter } from "@/lib/focus-targets";
import { getCenterApi } from "@/store/tools-bar";

const handlers = new Map<string, () => void>();

/** Register `startRename` for `panelId`. Returns an unregister function. */
export function registerTabRename(panelId: string, startRename: () => void): () => void {
  handlers.set(panelId, startRename);
  return () => {
    if (handlers.get(panelId) === startRename) handlers.delete(panelId);
  };
}

/**
 * Whether the center's active tab can be renamed from where focus is. Focus in another center
 * group belongs to that group's panel even though it isn't the active one: a browser page takes
 * focus without activating its group, and the key must stay with the page.
 */
export function canRenameActiveTab(): boolean {
  const panel = getCenterApi()?.activePanel;
  if (!panel || !handlers.has(panel.id)) return false;
  const focused = document.activeElement;
  const isFocusInOtherGroup =
    focused instanceof HTMLElement &&
    focused !== document.body &&
    isFocusInCenter() &&
    !panel.group.element.contains(focused);
  return !isFocusInOtherGroup;
}

/** Put the center's active tab into inline rename, when it is renameable. */
export function renameActiveTab(): void {
  const panelId = getCenterApi()?.activePanel?.id;
  if (panelId !== undefined) handlers.get(panelId)?.();
}
