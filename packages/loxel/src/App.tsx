import type { DockviewApi } from "dockview-react";

import "dockview-react/dist/styles/dockview.css";
import { useEffect, useRef } from "react";

import { CommandPaletteModal } from "./components/command-palette/CommandPaletteModal";
import { LAYOUT_VERSION, createDefaultLayout } from "./components/dockview/default-layout";
import {
  onOuterLayoutChange,
  onOuterLayoutRestored,
  performOuterClear,
  setupOuterDockview,
} from "./components/dockview/outer-dockview-setup";
import { outerComponents } from "./components/dockview/panels";
import { PersistedLayoutComponent } from "./components/dockview/PersistedLayout";
import { EmptyState } from "./components/EmptyState";
import { FileSearchModal } from "./components/file-search/FileSearchModal";
import { StatusBar } from "./components/panels/StatusBar";
import { TopBar } from "./components/panels/TopBar";
import { SearchModal } from "./components/search/SearchModal";
import { SettingsModal } from "./components/settings/SettingsModal";
import { Sidebar } from "./components/sidebar/Sidebar";
import { LeftToolsBar } from "./components/tools-bar/LeftToolsBar";
import { RightToolsBar } from "./components/tools-bar/RightToolsBar";
import { useDiffSource } from "./hooks/useDiffSource";
import { useKeybindings } from "./hooks/useKeybindings";
import { useLoxelEventListeners } from "./hooks/useLoxelEventListeners";
import { useThemeSync } from "./hooks/useThemeSync";
import { useWsSubscription } from "./hooks/useWsSubscription";
import { useWsBridge } from "./queries/ws-bridge";
import { useProjectStore } from "./store/projects";
import { useWorktreeToolsBar } from "./store/worktree-tools-bar";
import "./styles/dockview-theme.css";
import { useWorktreeStore } from "./store/worktrees";

export default function App() {
  useWsBridge();
  useDiffSource();
  useKeybindings();
  useLoxelEventListeners();
  useThemeSync();

  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const activeLeftPanel = useWorktreeToolsBar((s) => s.activeLeftPanel);
  const activeBottomPanel = useWorktreeToolsBar((s) => s.activeBottomPanel);
  const activeRightPanel = useWorktreeToolsBar((s) => s.activeRightPanel);
  const apiRef = useRef<DockviewApi | null>(null);

  // Sync active panels in dockview when tools bar state changes
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (activeLeftPanel) api.getPanel(activeLeftPanel)?.api.setActive();
    if (activeBottomPanel) api.getPanel(activeBottomPanel)?.api.setActive();
    if (activeRightPanel) api.getPanel(activeRightPanel)?.api.setActive();
  }, [activeLeftPanel, activeBottomPanel, activeRightPanel]);

  // Fetch initial data on mount
  useEffect(() => {
    useProjectStore.getState().fetchProjects();
  }, []);

  // WS subscription lifecycle
  useWsSubscription(activeWorktreePath);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      {activeWorktreePath !== null ? (
        <>
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <LeftToolsBar />
            <div className="flex-1 overflow-hidden">
              <PersistedLayoutComponent
                className="dockview-theme-abyss h-full"
                storagePrefix="outer"
                layoutKey={activeWorktreePath}
                layoutVersion={LAYOUT_VERSION}
                createDefaultLayout={createDefaultLayout}
                onApiReady={setupOuterDockview}
                onLayoutRestored={onOuterLayoutRestored}
                onLayoutChange={onOuterLayoutChange}
                performClear={performOuterClear}
                apiRef={apiRef}
                components={outerComponents}
                scrollbars="native"
              />
            </div>
            <RightToolsBar />
          </div>
          <StatusBar />
        </>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <div className="flex-1 overflow-hidden">
            <EmptyState />
          </div>
        </div>
      )}
      <SettingsModal />
      <SearchModal />
      <FileSearchModal />
      <CommandPaletteModal />
    </div>
  );
}
