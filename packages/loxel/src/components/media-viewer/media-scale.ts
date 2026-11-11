/**
 * Scale math for the media viewer. The viewer zooms the media frame (`/api/media-frame` in
 * `src/server/routes.ts`) with a CSS `scale`; this module says how big the frame draws the media
 * at scale 1, so the zoom label and the actual-size action can be measured against the natural size.
 */

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 50;

export interface Dimensions {
  width: number;
  height: number;
}

/** The media's natural (1:1) size, as the frame reports it. */
export interface MediaSize extends Dimensions {
  /**
   * The frame scales the media to fit the panel, enlarging it if needed (an SVG sized only by its
   * viewBox). Otherwise the frame draws it at its natural size, shrunk to fit but never enlarged.
   */
  scalesToFit: boolean;
}

/** On-screen size over natural size at scale 1. */
function fitRatio(media: MediaSize, viewport: Dimensions): number {
  const contain = Math.min(viewport.width / media.width, viewport.height / media.height);
  return media.scalesToFit ? contain : Math.min(1, contain);
}

/** The media's on-screen box at scale 1. */
export function fitWithin(media: MediaSize, viewport: Dimensions): Dimensions {
  const ratio = fitRatio(media, viewport);
  return { width: media.width * ratio, height: media.height * ratio };
}

/** The scale that draws one media pixel per screen pixel: 1 for media drawn at its natural size. */
export function actualSizeScale(media: MediaSize, viewport: Dimensions): number {
  const ratio = fitRatio(media, viewport);
  return Number.isFinite(ratio) && ratio > 0 ? 1 / ratio : 1;
}

/** The toolbar's zoom percentage: the on-screen size at `scale` relative to the natural size. */
export function zoomPercent(scale: number, media: MediaSize, viewport: Dimensions): number {
  return Math.round((scale / actualSizeScale(media, viewport)) * 100);
}

/**
 * Clamp a zoom step from `current` to `next` to the zoom limits. The limits widen to take in
 * `current`, which actual size can put outside them (a tiny SVG icon enlarged to fit a big panel),
 * so a step never jumps the opposite way.
 */
export function clampZoom(current: number, next: number): number {
  const min = Math.min(ZOOM_MIN, current);
  const max = Math.max(ZOOM_MAX, current);
  return Math.min(max, Math.max(min, next));
}
