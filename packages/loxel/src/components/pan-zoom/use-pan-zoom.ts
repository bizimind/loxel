/**
 * Zoom and pan for a full-panel view (the media viewer and the Mermaid diagram viewer): the
 * content is fitted into the viewport at zoom 1 and transformed about the viewport's center.
 * Pinch or Cmd/Ctrl+wheel zooms about the pointer, wheel and drag pan, double-click toggles fit
 * and actual size, and `=`/`+`, `-` and `0` zoom in, out and back to fit.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  actualSizeScale,
  type ContentSize,
  type Dimensions,
  DRAG_THRESHOLD,
  fitWithin,
  IDENTITY_VIEW,
  isZoomWheel,
  type PanZoomView,
  type Point,
  type WheelInput,
  wheelZoomFactor,
  ZOOM_STEP,
  zoomAt,
} from "@/components/pan-zoom/pan-zoom";

interface UsePanZoomOptions {
  /** The content's natural size, or null until it is known. */
  contentSize: ContentSize | null;
  /** Applies a view to the zoomed elements; called on each change, without waiting for a render. */
  onView: (view: PanZoomView) => void;
}

export function usePanZoom({ contentSize, onView }: UsePanZoomOptions) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<PanZoomView>(IDENTITY_VIEW);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  // Pans only move the elements; zooms also re-render so the percentage updates.
  const [scale, setScale] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [viewportSize, setViewportSize] = useState<Dimensions | null>(null);

  const fitBox = contentSize && viewportSize ? fitWithin(contentSize, viewportSize) : null;
  /** The scale that shows one content pixel per screen pixel. */
  const actualScale = contentSize && viewportSize ? actualSizeScale(contentSize, viewportSize) : 1;
  const actualScaleRef = useRef(actualScale);
  actualScaleRef.current = actualScale;

  const setView = useCallback((view: PanZoomView, keepAutoFit = false) => {
    viewRef.current = view;
    setScale(view.scale);
    if (!keepAutoFit) setAutoFit(false);
    onViewRef.current(view);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => setView(zoomAt(viewRef.current, factor, { x: 0, y: 0 })),
    [setView],
  );

  const fit = useCallback(() => {
    setView(IDENTITY_VIEW, true);
    setAutoFit(true);
  }, [setView]);

  const actualSize = useCallback(
    () => setView({ x: 0, y: 0, scale: actualScaleRef.current }),
    [setView],
  );

  const toggleAutoFit = useCallback(() => {
    if (autoFit) setAutoFit(false);
    else fit();
  }, [autoFit, fit]);

  /** Pan or zoom for a wheel event at `cursor`, a point in viewport coordinates. */
  const wheel = useCallback(
    (input: WheelInput, cursor: Point) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const view = viewRef.current;
      if (!isZoomWheel(input)) {
        setView({ ...view, x: view.x - input.deltaX, y: view.y - input.deltaY });
        return;
      }
      const at = {
        x: cursor.x - viewport.clientWidth / 2,
        y: cursor.y - viewport.clientHeight / 2,
      };
      setView(zoomAt(view, wheelZoomFactor(input.deltaY), at));
    },
    [setView],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      wheel(e, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [wheel]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // Auto-fit keeps the content fitted as the viewport resizes.
  useEffect(() => {
    if (autoFit && viewportSize) setView(IDENTITY_VIEW, true);
  }, [autoFit, viewportSize, setView]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY, view: viewRef.current };
      let dragging = false;
      const handleMouseMove = (me: MouseEvent) => {
        const dx = me.clientX - start.x;
        const dy = me.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!dragging) {
          dragging = true;
          setIsDragging(true);
        }
        setView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
      };
      const handleMouseUp = () => {
        setIsDragging(false);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [setView],
  );

  /** Toggles between fit and actual size. */
  const handleDoubleClick = useCallback(() => {
    if (Math.abs(viewRef.current.scale - 1) < 0.01) actualSize();
    else fit();
  }, [actualSize, fit]);

  /** Handles the zoom keys; returns whether the key was one of them. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === "=" || e.key === "+") zoomBy(ZOOM_STEP);
      else if (e.key === "-") zoomBy(1 / ZOOM_STEP);
      else if (e.key === "0") fit();
      else return false;
      e.preventDefault();
      return true;
    },
    [fit, zoomBy],
  );

  return {
    viewportRef,
    viewRef,
    fitBox,
    autoFit,
    isDragging,
    zoomPercent: Math.round((scale / actualScale) * 100),
    zoomBy,
    fit,
    actualSize,
    toggleAutoFit,
    wheel,
    handleMouseDown,
    handleDoubleClick,
    handleKeyDown,
  };
}
