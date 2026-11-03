/**
 * Maximizing a center group: it fills the center area while the other groups stay open behind it.
 * Dockview ends the state by itself when a panel of another group is activated or the grid changes.
 */

import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview-react";

import { activatePanel } from "@/store/layout-actions";
import { getCenterApi } from "@/store/tools-bar";

/**
 * Restore the layout whenever another group becomes active. Dockview leaves the state on when it
 * activates a hidden group by itself, as closing the group's active tab does, which would put
 * keyboard focus and every action on a group that can't be seen.
 */
export function restoreLayoutWhenAnotherGroupActivates(api: DockviewApi): void {
  api.onDidActiveGroupChange((group) => {
    if (group && api.hasMaximizedGroup() && !group.api.isMaximized()) api.exitMaximizedGroup();
  });
}

export function maximizeGroupLabel(isMaximized: boolean): string {
  return isMaximized ? "Restore Group Size" : "Maximize Group";
}

/** Floating and popout groups can't be maximized, and alone in the grid there is nothing to hide. */
function canToggleGroupMaximized(api: DockviewApi, group: DockviewGroupPanel): boolean {
  if (group.api.isMaximized()) return true;
  const isInGrid = (g: DockviewGroupPanel) => g.api.location.type === "grid";
  return isInGrid(group) && api.groups.some((g) => g !== group && isInGrid(g));
}

export function canTogglePanelMaximized(panel: IDockviewPanel): boolean {
  const api = getCenterApi();
  return api !== null && canToggleGroupMaximized(api, panel.group);
}

/**
 * Maximize `panel`'s group with `panel` as its active tab, or restore the group if it is maximized.
 */
export function togglePanelMaximized(panel: IDockviewPanel): void {
  const api = getCenterApi();
  if (!api || !canToggleGroupMaximized(api, panel.group)) return;
  if (panel.group.api.isMaximized()) {
    panel.group.api.exitMaximized();
    return;
  }
  activatePanel(api, panel);
  panel.group.api.maximize();
}

export function canToggleActiveGroupMaximized(): boolean {
  const panel = getCenterApi()?.activePanel;
  return panel !== undefined && canTogglePanelMaximized(panel);
}

export function toggleActiveGroupMaximized(): void {
  const panel = getCenterApi()?.activePanel;
  if (panel) togglePanelMaximized(panel);
}

export function activeGroupMaximizeLabel(): string {
  return maximizeGroupLabel(getCenterApi()?.activePanel?.group.api.isMaximized() ?? false);
}
