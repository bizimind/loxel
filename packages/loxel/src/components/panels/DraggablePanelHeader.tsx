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
  // Where the pointer went down. A dragstart's target is the draggable header itself, so this is
  // the only way to tell that a drag began in a control the header holds (a button, a text field):
  // that drag is the control's, not the panel's.
  const pressedRef = useRef<EventTarget | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pressedRef.current = e.target;
  }, []);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // A drag of something inside the header (selected text in a field, or content portalled out
      // of its React tree) is that element's own drag; leave it alone.
      if (e.target !== e.currentTarget) return;
      const pressed = pressedRef.current;
      if (pressed instanceof Element && pressed.closest(HEADER_CONTROLS)) {
        e.preventDefault();
        return;
      }
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
