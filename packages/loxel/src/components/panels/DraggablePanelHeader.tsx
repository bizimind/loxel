import type { ReactNode } from "react";
import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";
import type { PanelId } from "@/store/panel-config";

/**
 * Panel header that doubles as a drag handle for dockview panel rearrangement.
 * Sets the same drag data format as ToolsBarIcon so dockview's onDidDrop recognizes it.
 */
export function DraggablePanelHeader({
  panelId,
  children,
  className,
}: {
  panelId: PanelId;
  children: ReactNode;
  className?: string;
}) {
  const dragImageRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", panelId);
      e.dataTransfer.effectAllowed = "move";
      if (dragImageRef.current) {
        e.dataTransfer.setDragImage(dragImageRef.current, 16, 16);
      }
    },
    [panelId],
  );

  return (
    <div
      ref={dragImageRef}
      className={cn(
        "border-border shrink-0 cursor-grab border-b px-3 py-2 active:cursor-grabbing",
        className,
      )}
      draggable
      onDragStart={handleDragStart}
    >
      {children}
    </div>
  );
}
