/**
 * CenterHost — hosts the nested center dockview inside the outer dockview.
 *
 * The outer dockview manages sidebar zones (left/bottom/right) and the center host.
 * This component renders a second PersistedLayoutComponent for center panels
 * (editors, terminals, etc.) with their own persistence and tab management. Home, shown with no
 * worktree active, renders the same center layout on its own, without the outer dockview.
 */
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";

import { wsClient } from "@/api/client";
import { withDrawingCachePreserved } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { restoreLayoutWhenAnotherGroupActivates } from "@/lib/center-maximize";
import { focusAreaProps } from "@/lib/focus-targets";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchPendingOpen } from "@/lib/open-path";
import { activeLayoutKey, HOME_LAYOUT_KEY } from "@/store/active-worktree";
import { forgetClosedTabGroup } from "@/store/closed-tabs";
import { reattachActiveContent } from "@/store/layout-actions";
import { getCenterPanelDef } from "@/store/panel-config";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { getCenterApi, setCenterApi } from "@/store/tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { getWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

import { CenterWatermark } from "./center-watermark";
import { syncTerminalsFromLayout } from "./default-layout";
import { MaximizedGroupActions } from "./maximized-group-actions";
import { centerComponents, centerTabComponents, homeComponents, homeTabComponents } from "./panels";
import {
  PersistedLayoutComponent,
  type PersistedLayoutProps,
  isOuterSwapping,
} from "./PersistedLayout";

const CENTER_LAYOUT_VERSION = 1;
const uiLog = frontendLog.child("ui");

/**
 * The active worktree's editor area, in the outer dockview's `centerHost` panel. A worktree switch
 * remounts it (the outer swap removes its panel). Leaving for Home unmounts the outer dockview, so
 * a null active worktree keeps the key it has until then.
 */
export function CenterHostComponent(_props: IDockviewPanelProps) {
  const mountedKeyRef = useRef(activeLayoutKey());
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  return (
    <CenterLayout
      layoutKey={activeWorktreePath ?? mountedKeyRef.current}
      components={centerComponents}
      tabComponents={centerTabComponents}
    />
  );
}

/** Home's editor area: the panels that need no worktree, in a layout of its own. */
export function HomeCenter() {
  return (
    <CenterLayout
      layoutKey={HOME_LAYOUT_KEY}
      components={homeComponents}
      tabComponents={homeTabComponents}
    />
  );
}

function CenterLayout({
  layoutKey,
  components,
  tabComponents,
}: {
  layoutKey: string;
  components: PersistedLayoutProps["components"];
  tabComponents: PersistedLayoutProps["tabComponents"];
}) {
  // The layout this instance belongs to: the one shown at mount.
  const layoutKeyRef = useRef(layoutKey);
  const centerApiRef = useRef<DockviewApi | null>(null);
  const swappingRef = useRef(false);

  // Clear stale centerApi on unmount so no callers operate on a disposed API
  useEffect(() => {
    return () => setCenterApi(null);
  }, []);

  const handleApiReady = useCallback((api: DockviewApi) => {
    setCenterApi(api, layoutKeyRef.current);

    // Populate terminal instances from restored layout
    syncTerminals(api, layoutKeyRef.current);

    restoreLayoutWhenAnotherGroupActivates(api);

    // Background `renderer: "always"` tabs (browser panels) blank their group when re-added by a
    // move. The move event fires once the move has settled; add events are suppressed during moves
    // and fire before the active panel switches, so they can't be used here.
    api.onDidMovePanel(({ from, to }) => {
      reattachActiveContent(from);
      reattachActiveContent(to);
    });

    // A swap's groups come back with their ids when the layout is restored; these are gone for good.
    api.onDidRemoveGroup((group) => {
      if (!swappingRef.current && !isOuterSwapping()) {
        forgetClosedTabGroup(layoutKeyRef.current, group.id);
      }
    });

    api.onDidRemovePanel((event) => {
      // Skip during layout swaps — both the center's own swap (worktree switch
      // changes layoutKey) and the outer swap (unmounts CenterHost entirely).
      if (swappingRef.current || isOuterSwapping()) return;

      const removedDef = getCenterPanelDef(event.id);
      if (removedDef) {
        uiLog.info("Panel removed", { panelType: removedDef.type, panelId: event.id });
      }

      if (removedDef?.type === "terminal") {
        const terminalId = (event.params as { terminalId?: string })?.terminalId;
        if (terminalId) {
          wsClient.send({ type: "terminal_destroy", id: terminalId });
          usePanelNotificationStore.getState().unregisterPanel(terminalId);
        }
        if (layoutKeyRef.current !== HOME_LAYOUT_KEY) {
          getCurrentWorktreeToolsBar().getState().removeTerminal(event.id);
        }
      }

      // Notify server when the last panel showing an external file closes, so its watcher can
      // be cleaned up. Only files outside the worktree are sent; a file still shown by another
      // panel (an editor tab and a compare panel can show the same one) stays watched.
      const worktreePath = useWorktreeStore.getState().activeWorktreePath;
      if (worktreePath) {
        const others = api.panels.filter((p) => p.id !== event.id);
        const stillShown = new Set(others.flatMap((p) => panelFilePaths(p.params)));
        for (const filePath of panelFilePaths(event.params)) {
          if (filePath.startsWith(worktreePath + "/") || stillShown.has(filePath)) continue;
          wsClient.send({ type: "close_external_file", worktreePath, filePath });
        }
      }
    });

    // Open panels queued for this worktree while its editor area was being swapped in or had not
    // mounted yet (see openInWorktree). Deferred so only the instance that stays
    // mounted takes them — React StrictMode mounts the layout twice in dev — and left queued if
    // the worktree was switched away again meanwhile, for the next center mounted for it.
    queueMicrotask(() => {
      const key = layoutKeyRef.current;
      if (getCenterApi() !== api || activeLayoutKey() !== key) return;
      for (const open of getWorktreeUI(key).getState().takePendingOpens()) {
        dispatchPendingOpen(open);
      }
    });
  }, []);

  const handleLayoutRestored = useCallback((api: DockviewApi) => {
    syncTerminals(api, layoutKeyRef.current);
    for (const group of api.groups) reattachActiveContent(group);
  }, []);

  const handleClear = useCallback((api: DockviewApi) => {
    withDrawingCachePreserved(() => api.clear());
  }, []);

  return (
    <div className="h-full" {...focusAreaProps("center")}>
      <PersistedLayoutComponent
        className="dockview-theme-abyss h-full"
        storagePrefix="center"
        layoutKey={layoutKey}
        layoutVersion={CENTER_LAYOUT_VERSION}
        createDefaultLayout={() => {}}
        onApiReady={handleApiReady}
        onLayoutRestored={handleLayoutRestored}
        performClear={handleClear}
        components={components}
        tabComponents={tabComponents}
        watermarkComponent={CenterWatermark}
        rightHeaderActionsComponent={MaximizedGroupActions}
        scrollbars="native"
        apiRef={centerApiRef}
        swappingRef={swappingRef}
      />
    </div>
  );
}

/** Rebuild the worktree's terminal bookkeeping from its layout. Home's terminals are in no tools bar. */
function syncTerminals(api: DockviewApi, layoutKey: string): void {
  if (layoutKey !== HOME_LAYOUT_KEY) syncTerminalsFromLayout(api);
}

/** Files a center panel shows, from its params: `filePath` for editors, both sides for a comparison. */
function panelFilePaths(params: unknown): string[] {
  if (typeof params !== "object" || params === null) return [];
  const { filePath, oldPath, newPath } = params as Record<string, unknown>;
  return [filePath, oldPath, newPath].filter((p): p is string => typeof p === "string");
}
