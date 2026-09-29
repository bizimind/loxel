/**
 * Drag handle on the expanded sidebar's right edge. Reports live widths while dragging
 * and commits the final width once when the drag ends, so the persisted store is written
 * once per drag rather than on every pointer move. Like dockview's sashes it has no visible
 * hover or drag state — only the resize cursor.
 */
import { useEffect, useRef } from "react";

interface SidebarResizeHandleProps {
  /** Width at the start of a drag. */
  width: number;
  /** Called on every pointer move with the unclamped proposed width. */
  onResize: (width: number) => void;
  /** Called once when the drag ends (release, cancel, lost capture, or unmount). */
  onResizeEnd: (width: number) => void;
  /** Double-click resets the width. */
  onReset: () => void;
}

interface DragState {
  startX: number;
  startWidth: number;
  /** Last width derived from a real pointer position — committed when the drag ends. */
  lastWidth: number;
}

export function SidebarResizeHandle({
  width,
  onResize,
  onResizeEnd,
  onReset,
}: SidebarResizeHandleProps) {
  const dragRef = useRef<DragState | null>(null);

  const onResizeEndRef = useRef(onResizeEnd);
  useEffect(() => {
    onResizeEndRef.current = onResizeEnd;
  }, [onResizeEnd]);

  // The handle unmounts when the sidebar collapses; finish an in-flight drag so the
  // parent does not keep a stale live width.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      onResizeEndRef.current(drag.lastWidth);
    },
    [],
  );

  const trackPointer = (drag: DragState, clientX: number) => {
    drag.lastWidth = drag.startWidth + clientX - drag.startX;
  };

  /** Idempotent: pointerup/pointercancel and the lostpointercapture that follows both land here. */
  const finishDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    onResizeEnd(drag.lastWidth);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Prevent text selection while dragging
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width, lastWidth: width };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Button released without a pointerup reaching us (e.g. window lost focus)
    if (e.buttons === 0) {
      finishDrag();
      return;
    }
    trackPointer(drag, e.clientX);
    onResize(drag.lastWidth);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    trackPointer(drag, e.clientX);
    finishDrag();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize, double-click to reset"
      className="absolute top-0 -right-0.5 z-10 h-full w-1 cursor-ew-resize touch-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      // Cancel coordinates are unreliable (often 0) — keep the last tracked width instead
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onDoubleClick={onReset}
    />
  );
}
