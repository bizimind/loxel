/**
 * Imperative collapse/expand actions for sidebar zones.
 *
 * Collapse/expand is fully imperative (not reactive via useEffect hooks) to avoid
 * race conditions during layout swaps. React effects fire after the layout is
 * restored via fromJSON(), overriding correct sizes with stale ref values from
 * a different worktree. Imperative calls from togglePanel/createDefaultLayout
 * execute at the right time with the right per-scope sizes.
 *
 * This module is deliberately separate from default-layout.ts to avoid a circular
 * dependency: tools-bar.ts → layout-actions.ts, default-layout.ts → tools-bar.ts.
 */
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";

import { isCenterPanel } from "./panel-config";
import type { SidebarZone } from "./settings-store";
import { getCurrentWorktreeToolsBar } from "./worktree-tools-bar";

export type MoveDirection = "right" | "left" | "up" | "down";

/**
 * Find the nearest group adjacent to `sourceGroup` in the given direction.
 * Returns null if no group exists in that direction.
 *
 * In the nested architecture, this is called on the center API where all groups
 * are center groups — no filtering needed.
 */
export function findAdjacentCenterGroup(
  api: DockviewApi,
  sourceGroup: DockviewGroupPanel,
  direction: MoveDirection,
): DockviewGroupPanel | null {
  const sourceRect = sourceGroup.element.getBoundingClientRect();
  const sourceCx = sourceRect.left + sourceRect.width / 2;
  const sourceCy = sourceRect.top + sourceRect.height / 2;

  let best: DockviewGroupPanel | null = null;
  let bestDist = Infinity;

  for (const group of api.groups) {
    if (group === sourceGroup) continue;
    if (group.panels.length === 0) continue;

    const rect = group.element.getBoundingClientRect();

    let inDirection = false;
    switch (direction) {
      case "right":
        inDirection = rect.left >= sourceRect.right - 1;
        break;
      case "left":
        inDirection = rect.right <= sourceRect.left + 1;
        break;
      case "down":
        inDirection = rect.top >= sourceRect.bottom - 1;
        break;
      case "up":
        inDirection = rect.bottom <= sourceRect.top + 1;
        break;
      default: {
        const _exhaustive: never = direction;
        throw new Error(`Unknown move direction: ${String(_exhaustive)}`);
      }
    }
    if (!inDirection) continue;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(cx - sourceCx, cy - sourceCy);
    if (dist < bestDist) {
      bestDist = dist;
      best = group;
    }
  }

  return best;
}

/**
 * Determine which zone a dockview group is in, based on its physical position
 * relative to the center group. This is the ground truth — it reads from the
 * actual DOM layout, not from any store.
 */
export function getGroupZone(api: DockviewApi, group: DockviewGroupPanel): SidebarZone | "center" {
  if (group.panels.some((p) => p.id === "centerHost" || isCenterPanel(p.id))) return "center";

  const centerGroup = api.groups.find((g) =>
    g.panels.some((p) => p.id === "centerHost" || isCenterPanel(p.id)),
  );
  if (!centerGroup) return "left";

  const groupRect = group.element.getBoundingClientRect();
  const centerRect = centerGroup.element.getBoundingClientRect();

  if (groupRect.left >= centerRect.right - 1) return "right";
  if (groupRect.top >= centerRect.top + centerRect.height * 0.3) return "bottom";
  return "left";
}

/**
 * Find the dockview group for a sidebar zone.
 *
 * Uses toolbar entries as candidates, then **validates** each group's physical
 * position matches the requested zone. This prevents returning the wrong group
 * when entries and dockview are temporarily out of sync (e.g. during a move).
 *
 * @param skipPanelId - Panel to exclude from the search (used by movePanelToZone
 *   where the panel being moved is still in its old group at lookup time).
 */
export function findZoneGroup(
  api: DockviewApi,
  zone: SidebarZone,
  skipPanelId?: string,
): DockviewGroupPanel | null {
  const { leftEntries, bottomEntries, rightEntries } = getCurrentWorktreeToolsBar().getState();
  const entries = zone === "left" ? leftEntries : zone === "bottom" ? bottomEntries : rightEntries;
  for (const entry of entries) {
    if (entry.panelId === skipPanelId) continue;
    const group = api.getPanel(entry.panelId)?.group;
    if (group && getGroupZone(api, group) === zone) return group;
  }
  return null;
}

/**
 * Collapse a sidebar zone: constrain to 0 and resize to 0.
 * Saves the current size to per-scope sidebar sizes before collapsing
 * unless `skipSave` is set (used during layout restoration where sizes
 * come from the serialized layout, not the live group).
 */
export function collapseZone(api: DockviewApi, zone: SidebarZone, { skipSave = false } = {}): void {
  const group = findZoneGroup(api, zone);
  if (!group) return;

  const scoped = getCurrentWorktreeToolsBar();
  if (zone === "bottom") {
    if (!skipSave) {
      const h = group.api.height;
      if (h > 0) {
        const sizes = scoped.getState().sidebarSizes;
        scoped.setState({ sidebarSizes: { ...sizes, bottom: h } });
      }
    }
    group.api.setConstraints({ minimumHeight: 0, maximumHeight: 0 });
    group.api.setSize({ height: 0 });
  } else {
    if (!skipSave) {
      const w = group.api.width;
      if (w > 0) {
        const sizes = scoped.getState().sidebarSizes;
        scoped.setState({ sidebarSizes: { ...sizes, [zone]: w } });
      }
    }
    group.api.setConstraints({ minimumWidth: 0, maximumWidth: 0 });
    group.api.setSize({ width: 0 });
  }
}

/**
 * Expand a sidebar zone: remove constraints and restore saved size.
 * When `forceSize` is provided, uses that size directly instead of reading
 * from per-scope sidebar sizes (used during layout restoration).
 */
export function expandZone(
  api: DockviewApi,
  zone: SidebarZone,
  { forceSize }: { forceSize?: number } = {},
): void {
  const group = findZoneGroup(api, zone);
  if (!group) return;

  const scoped = getCurrentWorktreeToolsBar();
  const sizes = scoped.getState().sidebarSizes;

  if (zone === "bottom") {
    group.api.setConstraints({ minimumHeight: 0, maximumHeight: Number.MAX_SAFE_INTEGER });
    if (forceSize !== undefined) {
      group.api.setSize({ height: forceSize });
    } else {
      const h = group.api.height;
      if (h > 0) {
        scoped.setState({ sidebarSizes: { ...sizes, bottom: h } });
      } else {
        requestAnimationFrame(() => group.api.setSize({ height: sizes.bottom }));
      }
    }
  } else {
    group.api.setConstraints({ minimumWidth: 0, maximumWidth: Number.MAX_SAFE_INTEGER });
    if (forceSize !== undefined) {
      group.api.setSize({ width: forceSize });
    } else {
      const w = group.api.width;
      if (w > 0) {
        scoped.setState({ sidebarSizes: { ...sizes, [zone]: w } });
      } else {
        requestAnimationFrame(() => group.api.setSize({ width: sizes[zone] }));
      }
    }
  }
}
