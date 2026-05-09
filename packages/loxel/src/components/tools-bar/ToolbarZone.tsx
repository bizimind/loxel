import { createContext, useCallback, useContext } from "react";

import type { PanelId } from "@/store/panel-config";
import type { SidebarZone } from "@/store/settings-store";

import { movePanelToZone } from "@/store/tools-bar";

const ToolbarZoneContext = createContext<SidebarZone | null>(null);

/** Read the zone from the nearest ToolbarZone ancestor. */
export function useToolbarZone(): SidebarZone {
  const zone = useContext(ToolbarZoneContext);
  if (!zone) throw new Error("useToolbarZone must be used inside a <ToolbarZone>");
  return zone;
}

/**
 * Provides zone context to child ToolsBarIcon components and handles
 * drop events — when a toolbar icon is dropped here, the panel moves
 * to this zone in both the toolbar store and the dockview layout.
 */
export function ToolbarZone({
  zone,
  className,
  children,
}: {
  zone: SidebarZone;
  className?: string;
  children: React.ReactNode;
}) {
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const panelId = e.dataTransfer.getData("text/plain") as PanelId;
      if (panelId) movePanelToZone(panelId, zone);
    },
    [zone],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  return (
    <ToolbarZoneContext value={zone}>
      <div className={className} onDrop={handleDrop} onDragOver={handleDragOver}>
        {children}
      </div>
    </ToolbarZoneContext>
  );
}
