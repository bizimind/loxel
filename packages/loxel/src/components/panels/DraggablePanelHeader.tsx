import type { ReactNode } from "react";
import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";
import type { PanelId } from "@/store/panel-config";

/** Controls a header holds whose own press-and-drag must not start a panel drag. */
const HEADER_CONTROLS = "input, textarea, button, select";

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

  // A press on a control the header holds (a button, a text field) is that control's: suspend the
  // header's dragging for that press, so the gesture never becomes a panel drag. Suspending rather
  // than cancelling the dragstart matters: a cancelled dragstart gets no dragend, and window-level
  // drag tracking (BrowserPagePool's) would be left thinking a drag is still in progress.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pressed = e.target;
    e.currentTarget.draggable = !(pressed instanceof Element && pressed.closest(HEADER_CONTROLS));
  }, []);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // A drag of something inside the header (selected text in a field, or content portalled out
      // of its React tree) is that element's own drag; leave it alone.
      if (e.target !== e.currentTarget) return;
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
      onPointerDown={handlePointerDown}
      onDragStart={handleDragStart}
    >
      {children}
    </div>
  );
}
