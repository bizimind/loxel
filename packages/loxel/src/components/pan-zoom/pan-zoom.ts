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

/** Content's natural (1:1) size. */
export interface ContentSize extends Dimensions {
  /**
   * The view draws the content scaled to fit the viewport, enlarging it if needed (the media
   * frame does this for an SVG sized only by its viewBox). Otherwise it is drawn at its natural
   * size, shrunk to fit but never enlarged.
   */
  scalesToFit?: boolean;
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

/**
 * Clamp a zoom step from `current` to `next` to `limits`. The limits widen to take in `current`,
 * which actual size can put outside them (a tiny SVG icon enlarged to fit a big panel), so a step
 * never jumps the opposite way.
 */
export function clampZoom(
  current: number,
  next: number,
  limits: ScaleLimits = DEFAULT_LIMITS,
): number {
  const min = Math.min(limits.min, current);
  const max = Math.max(limits.max, current);
  return Math.min(max, Math.max(min, next));
}

/** `view` zoomed by `factor` about `at` (relative to the transform origin), which stays put. */
export function zoomAt(
  view: PanZoomView,
  factor: number,
  at: Point,
  limits: ScaleLimits = DEFAULT_LIMITS,
): PanZoomView {
  const scale = clampZoom(view.scale, view.scale * factor, limits);
  const ratio = scale / view.scale;
  return { scale, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

export function viewTransform(view: PanZoomView): string {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/** On-screen size over natural size at zoom 1 (see {@link ContentSize.scalesToFit}). */
function fitRatio(content: ContentSize, viewport: Dimensions): number {
  const contain = Math.min(viewport.width / content.width, viewport.height / content.height);
  return content.scalesToFit ? contain : Math.min(1, contain);
}

/** Content's on-screen box at zoom 1; empty for empty content or an empty viewport. */
export function fitWithin(content: ContentSize, viewport: Dimensions): Dimensions {
  const ratio = fitRatio(content, viewport);
  if (!(Number.isFinite(ratio) && ratio > 0)) return { width: 0, height: 0 };
  return { width: content.width * ratio, height: content.height * ratio };
}

/** The zoom that draws one content pixel per screen pixel; 1 when content or viewport is empty. */
export function actualSizeScale(content: ContentSize, viewport: Dimensions): number {
  const ratio = fitRatio(content, viewport);
  return Number.isFinite(ratio) && ratio > 0 ? 1 / ratio : 1;
}

/** The toolbar's zoom percentage: the on-screen size at `scale` relative to the natural size. */
export function zoomPercent(scale: number, content: ContentSize, viewport: Dimensions): number {
  return Math.round((scale / actualSizeScale(content, viewport)) * 100);
}
