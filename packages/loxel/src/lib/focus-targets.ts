/**
 * DOM markers for keyboard focus navigation (`lib/focus-navigation.ts`). Kept free of store
 * imports so any component can mark itself without pulling in the navigation logic.
 */

import type { PanelId } from "@/store/panel-config";

/** Marks a focus area container: the worktree sidebar or a side tool bar. */
export const FOCUS_AREA_ATTR = "data-focus-area";
export type FocusAreaName = "worktrees" | "left-bar" | "right-bar";

/** Marks a tool bar icon button; the value is its PanelId. */
export const TOOLBAR_PANEL_ATTR = "data-toolbar-panel";

/** Marks a keyboard-navigable worktree sidebar entry; the value is its path. */
export const SIDEBAR_ENTRY_ATTR = "data-sidebar-entry";

/** Marks the element inside a panel that should receive focus when the panel is navigated to. */
export const PANEL_AUTOFOCUS_ATTR = "data-panel-autofocus";

/** Props for a focus area container element. */
export function focusAreaProps(name: FocusAreaName) {
  return { [FOCUS_AREA_ATTR]: name };
}

/** Props for a tool bar icon button. */
export function toolbarPanelProps(panelId: PanelId) {
  return { [TOOLBAR_PANEL_ATTR]: panelId };
}

/**
 * Props for the element that should take focus when keyboard navigation lands on a panel that
 * registered no focus handler (see `lib/panel-focus.ts`); otherwise its first tabbable element
 * is focused.
 */
export function panelAutofocusProps() {
  return { [PANEL_AUTOFOCUS_ATTR]: "" };
}

/** Props for a keyboard-navigable worktree sidebar entry (a worktree or project root). */
export function sidebarEntryProps(path: string) {
  return { [SIDEBAR_ENTRY_ATTR]: path };
}
