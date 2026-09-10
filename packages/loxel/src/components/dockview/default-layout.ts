import type { DockviewApi } from "dockview-react";

import { collapseZone, expandZone, getGroupZone } from "@/store/layout-actions";
import type { PanelId } from "@/store/panel-config";
import {
  ZONE_DIRECTION_MAP,
  ZONE_INITIAL_SIZES,
  getCenterPanelDefByType,
  getPanelTitle,
  isCenterPanel,
} from "@/store/panel-config";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { buildToolbarEntries, getEffectiveLayoutConfig } from "@/store/settings-store";
import type { ToolsBarEntry } from "@/store/worktree-tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

// Bump when the default layout structure changes to force a reset of saved layouts.
export const LAYOUT_VERSION = 29;

/**
 * Creates the default 4-zone layout from SIDEBAR_PANELS config + user settings.
 * Zones are added in order: bottom (full-width), left, right.
 * Inactive zones are collapsed to size 0.
 */
export function createDefaultLayout(api: DockviewApi): void {
  if (api.panels.length > 0) return;

  const config = getEffectiveLayoutConfig();
  const { zoneDefaults, zonePanelOrder } = config;

  // Center host — contains the nested center dockview
  api.addPanel({ id: "centerHost", component: "centerHost", title: "Center" });

  // Add sidebar panels by zone. Bottom first so it spans full width.
  const zoneOrder = ["bottom", "left", "right"] as const;
  const sizeKey = { bottom: "initialHeight", left: "initialWidth", right: "initialWidth" } as const;

  for (const zone of zoneOrder) {
    const zonePanels = zonePanelOrder[zone];
    const zd = zoneDefaults[zone];
    const zoneSize = zd ? zd.size : ZONE_INITIAL_SIZES[zone];

    zonePanels.forEach((panelId, i) => {
      if (i === 0) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title: getPanelTitle(panelId),
          position: { referencePanel: "centerHost", direction: ZONE_DIRECTION_MAP[zone] },
          [sizeKey[zone]]: zoneSize,
        });
      } else {
        api.addPanel({
          id: panelId,
          component: panelId,
          title: getPanelTitle(panelId),
          position: { referencePanel: zonePanels[0]!, direction: "within" },
        });
      }
    });
  }

  // Sync toolbar entries + active panels from settings so icons match the configured zones
  getCurrentWorktreeToolsBar().setState({
    ...buildToolbarEntries(zonePanelOrder),
    activeLeftPanel: zoneDefaults.left ? (zoneDefaults.left.activePanel as PanelId) : null,
    activeBottomPanel: zoneDefaults.bottom ? (zoneDefaults.bottom.activePanel as PanelId) : null,
    activeRightPanel: zoneDefaults.right ? (zoneDefaults.right.activePanel as PanelId) : null,
  });

  applyHiddenHeaders(api);
  syncActiveFromStore(api);

  // Collapse all inactive zones for the fresh layout
  const { activeLeftPanel, activeBottomPanel, activeRightPanel } =
    getCurrentWorktreeToolsBar().getState();
  if (!activeLeftPanel) collapseZone(api, "left");
  if (!activeBottomPanel) collapseZone(api, "bottom");
  if (!activeRightPanel) collapseZone(api, "right");
}

/**
 * Re-apply collapse/expand state on all sidebar zones after a layout restoration.
 *
 * This is necessary because dockview's `toJSON()`/`fromJSON()` does NOT serialize
 * group constraints (minimumWidth, maximumWidth, etc.), and may serialize
 * pre-constraint sizes (e.g. a collapsed zone saved with its original 300px height
 * instead of 0). Without this, restored layouts show all zones expanded.
 *
 * Two-pass approach: first collapse inactive zones (which may redistribute freed
 * space to active zones), then restore active zones to their correct saved sizes.
 */
export function applyZoneConstraints(api: DockviewApi): void {
  const scoped = getCurrentWorktreeToolsBar();
  const {
    activeLeftPanel,
    activeBottomPanel,
    activeRightPanel,
    sidebarSizes: sizes,
  } = scoped.getState();

  const zones = [
    { zone: "left" as const, active: activeLeftPanel },
    { zone: "bottom" as const, active: activeBottomPanel },
    { zone: "right" as const, active: activeRightPanel },
  ] as const;

  // First pass: collapse inactive zones (skipSave: layout sizes are from serialization, not live)
  for (const { zone, active } of zones) {
    if (!active) collapseZone(api, zone, { skipSave: true });
  }

  // Second pass: unconstrain active zones and restore their saved sizes
  // (collapsing inactive zones may have caused redistribution)
  for (const { zone, active } of zones) {
    if (active) expandZone(api, zone, { forceSize: sizes[zone] });
  }
}

/**
 * Hide all group headers in the outer dockview.
 * The outer dockview only has sidebar groups and the centerHost — none need visible tabs.
 * Center panel tabs are managed by the nested center dockview.
 */
export function applyHiddenHeaders(api: DockviewApi): void {
  for (const group of api.groups) {
    group.header.hidden = true;
  }
}

/** Set active panels in dockview to match the tools bar store state. */
export function syncActiveFromStore(api: DockviewApi): void {
  const { activeLeftPanel, activeBottomPanel, activeRightPanel } =
    getCurrentWorktreeToolsBar().getState();
  if (activeLeftPanel) api.getPanel(activeLeftPanel)?.api.setActive();
  if (activeBottomPanel) api.getPanel(activeBottomPanel)?.api.setActive();
  if (activeRightPanel) api.getPanel(activeRightPanel)?.api.setActive();
}

/**
 * Rebuild toolbar entries and sidebar sizes from the outer dockview layout.
 *
 * Called after layout restore on app restart. Scoped snapshots (toolbar entries,
 * sidebar sizes) are in-memory and don't survive restart. The dockview layout IS
 * persisted to localStorage, so we derive the correct state from it.
 */
export function syncSidebarFromLayout(api: DockviewApi): void {
  const leftEntries: ToolsBarEntry[] = [];
  const bottomEntries: ToolsBarEntry[] = [];
  const rightEntries: ToolsBarEntry[] = [];

  for (const panel of api.panels) {
    if (isCenterPanel(panel.id) || panel.id === "centerHost") continue;
    const zone = getGroupZone(api, panel.group);
    if (zone === "left") leftEntries.push({ panelId: panel.id as PanelId });
    else if (zone === "bottom") bottomEntries.push({ panelId: panel.id as PanelId });
    else if (zone === "right") rightEntries.push({ panelId: panel.id as PanelId });
  }

  const scoped = getCurrentWorktreeToolsBar();
  scoped.setState({ leftEntries, bottomEntries, rightEntries });

  const newSizes = { ...scoped.getState().sidebarSizes };
  for (const group of api.groups) {
    const zone = getGroupZone(api, group);
    if (zone === "center") continue;
    const size = zone === "bottom" ? group.api.height : group.api.width;
    if (size > 0) newSizes[zone] = size;
  }
  scoped.setState({ sidebarSizes: newSizes });
}

/**
 * Populate terminal instances from the center dockview layout.
 *
 * Called after center layout restore. The terminals[] array in ToolsBarStore is not
 * persisted — only the dockview layout is — so we derive terminal instances from it.
 */
export function syncTerminalsFromLayout(api: DockviewApi): void {
  const terminalDef = getCenterPanelDefByType("terminal")!;
  const terminals = api.panels
    .filter((p) => p.id.startsWith(terminalDef.idPrefix))
    .map((p) => {
      const raw = p.params;
      const terminalId =
        typeof raw === "object" &&
        raw !== null &&
        "terminalId" in raw &&
        typeof (raw as Record<string, unknown>).terminalId === "string"
          ? ((raw as Record<string, unknown>).terminalId as string)
          : p.id.slice(terminalDef.idPrefix.length);
      return { id: p.id, title: p.title ?? terminalDef.titlePrefix, terminalId };
    });

  getCurrentWorktreeToolsBar().setState({ terminals });

  // Register all restored terminals with the notification store
  const wtPath = useWorktreeStore.getState().activeWorktreePath;
  if (wtPath) {
    const store = usePanelNotificationStore.getState();
    for (const t of terminals) {
      store.registerPanel(t.terminalId, wtPath);
    }
  }
}

export type SplitPosition = { referencePanel: string; direction: "right" | "below" };

/**
 * Gap-filling panel title: scans existing panel titles and returns the first
 * unused number. E.g. if "Terminal" and "Terminal 3" exist, returns "Terminal 2".
 *
 * Naming convention: number 1 → bare prefix ("Terminal"), 2+ → "Terminal 2", etc.
 * Automatically worktree-scoped because api.panels only contains the active layout.
 */
export function nextPanelTitle(api: DockviewApi, prefix: string): string {
  const used = new Set<number>();
  for (const p of api.panels) {
    const t = p.title ?? "";
    if (t === prefix) {
      used.add(1);
    } else if (t.startsWith(prefix + " ")) {
      const n = parseInt(t.slice(prefix.length + 1), 10);
      if (Number.isFinite(n)) used.add(n);
    }
  }
  let n = 1;
  while (used.has(n)) n++;
  return n === 1 ? prefix : `${prefix} ${n}`;
}
