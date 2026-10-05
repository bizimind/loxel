import type { DockviewApi } from "dockview-react";

import { collapseZone, expandZone, findZoneGroup } from "./layout-actions";
import { usePanelBadgeStore } from "./panel-badges";
import type { PanelId, PanelZone } from "./panel-config";
import { ALLOWED_ZONES, ZONE_DIRECTION_MAP, getPanelTitle } from "./panel-config";
import type { SidebarZone } from "./settings-store";
import type { ToolsBarEntry } from "./worktree-tools-bar";
import { getCurrentWorktreeToolsBar } from "./worktree-tools-bar";

/** Maps zone -> the state key for its active panel. */
const ACTIVE_PANEL_KEY = {
  left: "activeLeftPanel",
  bottom: "activeBottomPanel",
  right: "activeRightPanel",
} as const;

/** Maps zone -> the state key for its entries array. */
const ENTRIES_KEY = {
  left: "leftEntries",
  bottom: "bottomEntries",
  right: "rightEntries",
} as const;

/** Find which zone a panel is in, or null if not present. */
function findPanelZone(
  panelId: PanelId,
  leftEntries: ToolsBarEntry[],
  bottomEntries: ToolsBarEntry[],
  rightEntries: ToolsBarEntry[],
): SidebarZone | null {
  if (leftEntries.some((e) => e.panelId === panelId)) return "left";
  if (bottomEntries.some((e) => e.panelId === panelId)) return "bottom";
  if (rightEntries.some((e) => e.panelId === panelId)) return "right";
  return null;
}

/** The zone a sidebar panel's tool bar icon is in, or null if it has none. */
export function getSidebarPanelZone(panelId: PanelId): SidebarZone | null {
  const { leftEntries, bottomEntries, rightEntries } = getCurrentWorktreeToolsBar().getState();
  return findPanelZone(panelId, leftEntries, bottomEntries, rightEntries);
}

/** The visible panel of a sidebar zone, or null when the zone is collapsed. */
export function getActiveSidebarPanel(zone: SidebarZone): PanelId | null {
  return getCurrentWorktreeToolsBar().getState()[ACTIVE_PANEL_KEY[zone]];
}

/** Module-level reference to the outer (sidebar) dockview API. */
let outerApi: DockviewApi | null = null;
/** Module-level reference to the center (editor/terminal) dockview API. */
let centerApi: DockviewApi | null = null;
/** The worktree the center API was mounted for — a worktree switch remounts the center. */
let centerApiWorktree: string | null = null;
const centerApiListeners = new Set<(api: DockviewApi | null) => void>();

/** Set the outer dockview API reference. Called from App.tsx onReady. */
export function setDockviewApi(api: DockviewApi | null): void {
  outerApi = api;
}

/** The content element of a sidebar panel, or null if the outer layout doesn't hold it. */
export function getSidebarPanelElement(panelId: PanelId): HTMLElement | null {
  return outerApi?.getPanel(panelId)?.view.content.element ?? null;
}

/** Set the center dockview API reference and the worktree it shows. Called from CenterHost. */
export function setCenterApi(api: DockviewApi | null, worktreePath: string | null = null): void {
  centerApi = api;
  centerApiWorktree = api ? worktreePath : null;
  for (const listener of centerApiListeners) {
    listener(api);
  }
}

/** Get the center dockview API (for panel creation, action handling, etc.). */
export function getCenterApi(): DockviewApi | null {
  return centerApi;
}

/**
 * The worktree the current center API belongs to. Right after a worktree switch the outgoing
 * center stays registered until it unmounts, so it still reports the previous worktree.
 */
export function getCenterApiWorktree(): string | null {
  return centerApiWorktree;
}

export function subscribeCenterApi(listener: (api: DockviewApi | null) => void): () => void {
  centerApiListeners.add(listener);
  return () => centerApiListeners.delete(listener);
}

/**
 * Toggle a sidebar panel open/closed.
 * Reads entries from the scoped store, writes active panel state to it,
 * and uses the global outerApi for dockview expand/collapse.
 */
export function togglePanel(panelId: PanelId): void {
  const scoped = getCurrentWorktreeToolsBar();
  const state = scoped.getState();
  const { leftEntries, bottomEntries, rightEntries } = state;
  const zone = findPanelZone(panelId, leftEntries, bottomEntries, rightEntries);
  if (!zone) return;

  const key = ACTIVE_PANEL_KEY[zone];
  const current = state[key];
  const nowActive = current !== panelId;
  scoped.setState({ [key]: nowActive ? panelId : null });

  if (nowActive) {
    const badges = usePanelBadgeStore.getState();
    if (panelId === "logs") {
      badges.markLogsSeenOnActivation();
    } else {
      badges.clear(panelId);
    }
  }

  if (outerApi) {
    if (nowActive) expandZone(outerApi, zone);
    else collapseZone(outerApi, zone);
  }
}

/** Panels to open once the outer layout being swapped in (worktree switch) is restored. */
let panelsToShowAfterRestore: PanelId[] = [];

/**
 * Open a sidebar panel once the next outer layout restore completes. Use right after switching
 * worktrees: until then the outer API still holds the previous worktree's layout.
 */
export function showPanelAfterLayoutRestore(panelId: PanelId): void {
  panelsToShowAfterRestore.push(panelId);
}

/** Open the panels queued by {@link showPanelAfterLayoutRestore}. Called on outer restore. */
export function showPanelsQueuedForRestore(): void {
  const panelIds = panelsToShowAfterRestore;
  panelsToShowAfterRestore = [];
  for (const panelId of panelIds) showPanel(panelId);
}

/** Open a sidebar panel if it is not already the active panel of its zone. */
export function showPanel(panelId: PanelId): void {
  const state = getCurrentWorktreeToolsBar().getState();
  const zone = findPanelZone(panelId, state.leftEntries, state.bottomEntries, state.rightEntries);
  if (!zone || state[ACTIVE_PANEL_KEY[zone]] === panelId) return;
  togglePanel(panelId);
}

/**
 * Move a panel between toolbar zones (entries only, no dockview move).
 * Used when dockview has already moved the panel (e.g. onDidDrop in App.tsx).
 */
export function movePanel(panelId: PanelId, toZone: PanelZone): void {
  if (toZone === "center") return;

  const scoped = getCurrentWorktreeToolsBar();
  const state = scoped.getState();
  const fromZone = findPanelZone(
    panelId,
    state.leftEntries,
    state.bottomEntries,
    state.rightEntries,
  );
  if (!fromZone || fromZone === toZone) return;

  const allowed = ALLOWED_ZONES[panelId];
  if (allowed && !allowed.includes(toZone)) return;

  // Move entry from source to target
  const fromKey = ENTRIES_KEY[fromZone];
  const toKey = ENTRIES_KEY[toZone];
  const updates: Record<string, unknown> = {
    [fromKey]: state[fromKey].filter((e) => e.panelId !== panelId),
    [toKey]: [...state[toKey], { panelId }],
  };

  // Preserve active state: if the panel was active in source, activate in target
  const wasActive = state[ACTIVE_PANEL_KEY[fromZone]] === panelId;
  if (wasActive) {
    updates[ACTIVE_PANEL_KEY[fromZone]] = null;
    updates[ACTIVE_PANEL_KEY[toZone]] = panelId;
  }

  scoped.setState(updates);

  if (wasActive && outerApi) {
    collapseZone(outerApi, fromZone);
  }
}

/**
 * Move a panel to a different toolbar zone AND its dockview group.
 *
 * This is the single correct way to move a panel between zones from
 * the toolbar UI. It updates both the store entries and the dockview
 * layout in one operation. Used by ToolbarZone drop handlers.
 *
 * For moves initiated by dockview itself (onDidDrop in App.tsx), use
 * `movePanel()` instead -- the dockview panel has already been moved,
 * only entries need updating.
 */
export function movePanelToZone(panelId: PanelId, toZone: SidebarZone): void {
  const scoped = getCurrentWorktreeToolsBar();
  const activeKey = ACTIVE_PANEL_KEY[toZone];
  const targetWasCollapsed = scoped.getState()[activeKey] === null;

  movePanel(panelId, toZone);

  if (!outerApi) return;

  const panel = outerApi.getPanel(panelId);
  if (!panel) return;

  // Find target group from the updated entries, skipping the moved panel
  // (it's still physically in its old group at this point)
  const targetGroup = findZoneGroup(outerApi, toZone, panelId);

  if (targetGroup) {
    panel.api.moveTo({ group: targetGroup, position: "center" });
  } else {
    // Target zone is empty (no group exists) -- close and re-add with zone positioning.
    // This re-mounts the React component, but sidebar panels are stateless (store-driven).
    const centerRef = outerApi.getPanel("centerHost");
    if (!centerRef) return;

    panel.api.close();
    outerApi.addPanel({
      id: panelId,
      component: panelId,
      title: getPanelTitle(panelId),
      position: { referencePanel: centerRef.id, direction: ZONE_DIRECTION_MAP[toZone] },
    });
  }

  // If the panel is now active in the target zone and it was collapsed, expand it
  if (targetWasCollapsed && scoped.getState()[activeKey] === panelId) {
    expandZone(outerApi, toZone);
  }
}
