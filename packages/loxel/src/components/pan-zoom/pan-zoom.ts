/**
 * Pan and zoom geometry shared by Loxel's zoomable views (the media viewer, the Mermaid diagram
 * viewer and inline Mermaid previews), so they all zoom and pan the same way. A view is
 * `translate(x, y) scale(scale)` on an element; points are relative to its transform origin.
 */

export const ZOOM_STEP = 1.2;
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 50;
/** Pointer travel (px) before a press on a view becomes a pan instead of a click. */
export const DRAG_THRESHOLD = 3;

export interface Point {
  x: number;
  y: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface PanZoomView extends Point {
  scale: number;
}

export interface ScaleLimits {
  min: number;
  max: number;
}

export const IDENTITY_VIEW: PanZoomView = { x: 0, y: 0, scale: 1 };

const DEFAULT_LIMITS: ScaleLimits = { min: ZOOM_MIN, max: ZOOM_MAX };

/** The fields of a wheel event that pan or zoom a view. */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Trackpad pinches arrive as Ctrl+wheel; Cmd/Ctrl+wheel zooms too. Any other wheel pans. */
export function isZoomWheel(input: WheelInput): boolean {
  return input.ctrlKey || input.metaKey;
}

/** The zoom factor of a pinch or Cmd/Ctrl+wheel step. */
export function wheelZoomFactor(deltaY: number): number {
  return 2 ** (-deltaY * 0.01);
}

/** `view` zoomed by `factor` about `at` (relative to the transform origin), which stays put. */
export function zoomAt(
  view: PanZoomView,
  factor: number,
  at: Point,
  limits: ScaleLimits = DEFAULT_LIMITS,
): PanZoomView {
  const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

export function viewTransform(view: PanZoomView): string {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/**
 * Content's on-screen box at zoom 1: its natural size, shrunk (never grown) to fit the viewport.
 * Empty content or an empty viewport gives an empty box.
 */
export function fitWithin(content: Dimensions, viewport: Dimensions): Dimensions {
  const ratio = Math.min(1, viewport.width / content.width, viewport.height / content.height);
  if (!(ratio > 0)) return { width: 0, height: 0 };
  return { width: content.width * ratio, height: content.height * ratio };
}

/** The zoom that shows content fitted into `box` at its natural size; 1 when either is empty. */
export function actualSizeScale(content: Dimensions, box: Dimensions): number {
  return content.width > 0 && box.width > 0 ? content.width / box.width : 1;
}
