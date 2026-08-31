/**
 * Outer dockview setup — one-time initialization, drag constraints, and layout callbacks.
 *
 * These functions configure the outer (sidebar) dockview's zone model.
 * They live in the dockview layer alongside default-layout.ts.
 */
import type { DockviewApi } from "dockview-react";

import type { PanelId } from "@/store/panel-config";

import { withDrawingCachePreserved } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { getGroupZone } from "@/store/layout-actions";
import { ALLOWED_ZONES } from "@/store/panel-config";
import { movePanelToZone, movePanel, setDockviewApi } from "@/store/tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";

import {
  applyHiddenHeaders,
  applyZoneConstraints,
  syncActiveFromStore,
  syncSidebarFromLayout,
} from "./default-layout";
import { setOuterSwapping } from "./PersistedLayout";

/**
 * One-time setup for the outer dockview.
 * Registers drag constraints, external drop handling, and sidebar sync.
 */
export function setupOuterDockview(api: DockviewApi): void {
  setDockviewApi(api);

  // Derive toolbar entries from the outer layout on first load from localStorage
  syncSidebarFromLayout(api);

  // Lock centerHost group — it should never accept drops or show tabs
  const centerHostGroup = api.getPanel("centerHost")?.group;
  if (centerHostGroup) {
    centerHostGroup.locked = "no-drop-target";
    centerHostGroup.header.hidden = true;
  }

  // Sidebar panel drag (DraggablePanelHeader) — sync toolbar entries after drop
  api.onWillDragPanel((event) => {
    const draggedId = event.panel.id as PanelId;
    event.nativeEvent.target?.addEventListener(
      "dragend",
      () => {
        const panel = api.getPanel(draggedId);
        if (!panel?.group) return;
        const newZone = getGroupZone(api, panel.group);
        if (newZone === "center") return;
        const { leftEntries, bottomEntries, rightEntries } =
          getCurrentWorktreeToolsBar().getState();
        const currentZone = leftEntries.some((e) => e.panelId === draggedId)
          ? "left"
          : bottomEntries.some((e) => e.panelId === draggedId)
            ? "bottom"
            : rightEntries.some((e) => e.panelId === draggedId)
              ? "right"
              : null;
        if (currentZone && currentZone !== newZone) {
          movePanel(draggedId, newZone);
        }
      },
      { once: true },
    );
  });

  // Docking restrictions for the outer dockview
  api.onWillShowOverlay((event) => {
    const targetGroup = event.group;

    // Edge/container drops — block entirely
    if (!targetGroup) {
      event.preventDefault();
      return;
    }

    // Block drops on the centerHost group
    if (targetGroup.panels.some((p) => p.id === "centerHost")) {
      event.preventDefault();
      return;
    }

    // Sidebar groups never split — all panels in a zone share one tabbed group
    if (event.position !== "center") {
      event.preventDefault();
      return;
    }

    const draggedPanel = event.panel;

    // External drag (toolbar icon) — always allowed on sidebar groups
    // (centerHost already blocked above)
    if (!draggedPanel) return;

    // Internal dockview drags (DraggablePanelHeader) — check allowed zones
    const targetZone = getGroupZone(api, targetGroup);
    const allowed = ALLOWED_ZONES[draggedPanel.id as PanelId];
    if (allowed && !allowed.includes(targetZone)) {
      event.preventDefault();
    }
  });

  // Accept external drags (toolbar icons)
  api.onUnhandledDragOver((event) => {
    const types =
      "dataTransfer" in event.nativeEvent ? event.nativeEvent.dataTransfer?.types : undefined;
    if (types?.includes("text/plain")) {
      event.accept();
    }
  });

  // Handle external drops — toolbar icon moves
  api.onDidDrop((event) => {
    if (!event.group) return;

    // Toolbar icon drop on a sidebar group — move panel via movePanelToZone
    const panelId =
      "dataTransfer" in event.nativeEvent
        ? event.nativeEvent.dataTransfer?.getData("text/plain")
        : undefined;
    if (!panelId) return;

    const dropZone = getGroupZone(api, event.group);
    if (dropZone === "center") return; // Blocked by onWillShowOverlay, but safety net

    movePanelToZone(panelId as PanelId, dropZone);
  });
}

/** Called after every layout restore (initial + worktree switch). */
export function onOuterLayoutRestored(api: DockviewApi): void {
  applyHiddenHeaders(api);
  syncActiveFromStore(api);
  applyZoneConstraints(api);
  setOuterSwapping(false);
}

/** Track sidebar sizes on layout changes. */
export function onOuterLayoutChange(api: DockviewApi): void {
  const scoped = getCurrentWorktreeToolsBar();
  const state = scoped.getState();
  const curActiveLeft = state.activeLeftPanel;
  const curActiveBottom = state.activeBottomPanel;
  const curActiveRight = state.activeRightPanel;
  const curLeftPanelId = curActiveLeft ?? state.leftEntries[0]?.panelId ?? null;
  const curBottomPanelId = curActiveBottom ?? state.bottomEntries[0]?.panelId ?? null;
  const curRightPanelId = curActiveRight ?? state.rightEntries[0]?.panelId ?? null;

  const leftPanel = curLeftPanelId ? api.getPanel(curLeftPanelId) : null;
  const rightPanel = curRightPanelId ? api.getPanel(curRightPanelId) : null;
  const bottomPanel = curBottomPanelId ? api.getPanel(curBottomPanelId) : null;

  const sizes = { ...state.sidebarSizes };
  let changed = false;

  if (leftPanel?.group && curActiveLeft !== null) {
    const w = leftPanel.group.api.width;
    if (w > 0) {
      sizes.left = w;
      changed = true;
    }
  }
  if (rightPanel?.group && curActiveRight !== null) {
    const w = rightPanel.group.api.width;
    if (w > 0) {
      sizes.right = w;
      changed = true;
    }
  }
  if (bottomPanel?.group && curActiveBottom !== null) {
    const h = bottomPanel.group.api.height;
    if (h > 0) {
      sizes.bottom = h;
      changed = true;
    }
  }

  if (changed) scoped.setState({ sidebarSizes: sizes });
}

/** Custom clear that preserves drawing caches during layout swap. */
export function performOuterClear(api: DockviewApi): void {
  setOuterSwapping(true);
  withDrawingCachePreserved(() => api.clear());
}
