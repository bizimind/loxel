/**
 * CenterHost — hosts the nested center dockview inside the outer dockview.
 *
 * The outer dockview manages sidebar zones (left/bottom/right) and the center host.
 * This component renders a second PersistedLayoutComponent for center panels
 * (editors, terminals, agents, etc.) with their own persistence and tab management.
 */
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";

import { wsClient } from "@/api/client";
import { withDrawingCachePreserved } from "@/components/excalidraw-editor/ExcalidrawEditor";
import { frontendLog } from "@/lib/frontend-logger";
import { useAgentDevToolsStore } from "@/store/agent-devtools";
import { getCenterPanelDef } from "@/store/panel-config";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { setCenterApi } from "@/store/tools-bar";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

import { syncTerminalsFromLayout } from "./default-layout";
import { CenterWatermark, centerComponents, centerTabComponents } from "./panels";
import { PersistedLayoutComponent, isOuterSwapping } from "./PersistedLayout";

const CENTER_LAYOUT_VERSION = 1;
const uiLog = frontendLog.child("ui");

export function CenterHostComponent(_props: IDockviewPanelProps) {
  const layoutKey = useWorktreeStore((s) => s.activeWorktreePath ?? "default");
  const centerApiRef = useRef<DockviewApi | null>(null);
  const swappingRef = useRef(false);

  // Clear stale centerApi on unmount so no callers operate on a disposed API
  useEffect(() => {
    return () => setCenterApi(null);
  }, []);

  const handleApiReady = useCallback((api: DockviewApi) => {
    setCenterApi(api);

    // Populate terminal instances from restored layout
    syncTerminalsFromLayout(api);

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
        getCurrentWorktreeToolsBar().getState().removeTerminal(event.id);
      }

      if (removedDef?.type === "agentDevTools") {
        const params = event.params;
        const sessionId =
          typeof params === "object" && params !== null && "sessionId" in params
            ? String((params as Record<string, unknown>).sessionId)
            : undefined;
        if (sessionId) {
          useAgentDevToolsStore.getState().removeSession(sessionId);
        }
      }

      if (removedDef?.type === "agent") {
        const params = event.params;
        const sessionId =
          typeof params === "object" && params !== null && "sessionId" in params
            ? String((params as Record<string, unknown>).sessionId)
            : undefined;
        if (sessionId) {
          wsClient.send({ type: "agent_detach", id: sessionId });
        }
      }

      // Notify server when an external file panel is closed so watchers can be cleaned up.
      // Only send for files outside the worktree to avoid unnecessary messages.
      const rawParams: unknown = event.params;
      const filePath =
        rawParams !== undefined &&
        rawParams !== null &&
        typeof rawParams === "object" &&
        "filePath" in rawParams &&
        typeof (rawParams as { filePath?: unknown }).filePath === "string"
          ? (rawParams as { filePath: string }).filePath
          : undefined;
      const worktreePath = useWorktreeStore.getState().activeWorktreePath;
      if (filePath && worktreePath && !filePath.startsWith(worktreePath + "/")) {
        wsClient.send({ type: "close_external_file", worktreePath, filePath });
      }
    });
  }, []);

  const handleLayoutRestored = useCallback((api: DockviewApi) => {
    syncTerminalsFromLayout(api);
  }, []);

  const handleClear = useCallback((api: DockviewApi) => {
    withDrawingCachePreserved(() => api.clear());
  }, []);

  return (
    <PersistedLayoutComponent
      className="dockview-theme-abyss h-full"
      storagePrefix="center"
      layoutKey={layoutKey}
      layoutVersion={CENTER_LAYOUT_VERSION}
      createDefaultLayout={() => {}}
      onApiReady={handleApiReady}
      onLayoutRestored={handleLayoutRestored}
      performClear={handleClear}
      components={centerComponents}
      tabComponents={centerTabComponents}
      watermarkComponent={CenterWatermark}
      scrollbars="native"
      apiRef={centerApiRef}
      swappingRef={swappingRef}
    />
  );
}
