import { createCanvas } from "@napi-rs/canvas";

import { FONT_FAMILIES, type FontFamilyName } from "./element-defaults.ts";
import { generateElementId } from "./element-id.ts";
import type { ExcalidrawElement } from "./excalidraw-types.ts";

/** Properties shared by all element creation options */
export interface BaseOptions {
  id?: string;
  x?: number;
  y?: number;
  stroke?: string;
  bg?: string;
  fill?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
}

/** Options for container shapes (rect, ellipse, diamond) */
export interface ContainerOptions extends BaseOptions {
  width?: number;
  height?: number;
  round?: number;
  text?: string;
  textFontSize?: number;
}

export interface TextOptions extends BaseOptions {
  text: string;
  fontSize?: number;
  fontFamily?: FontFamilyName;
  textAlign?: "left" | "center" | "right";
}

export interface ArrowOptions extends BaseOptions {
  points?: [number, number][];
  from?: string;
  to?: string;
  startHead?: string;
  endHead?: string;
  text?: string;
}

export interface FreeDrawOptions extends BaseOptions {
  points: [number, number][];
}

export interface FrameOptions extends BaseOptions {
  width?: number;
  height?: number;
  name?: string;
  children?: string[];
}

/** Build a skeleton object for convertToExcalidrawElements */
function baseSkeleton(type: string, opts: BaseOptions): Record<string, unknown> {
  return {
    id: opts.id ?? generateElementId(),
    type,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    strokeColor: opts.stroke ?? "#1e1e1e",
    backgroundColor: opts.bg ?? "transparent",
    fillStyle: opts.fill ?? "solid",
    strokeWidth: opts.strokeWidth ?? 2,
    strokeStyle: opts.strokeStyle ?? "solid",
    roughness: opts.roughness ?? 1,
    opacity: opts.opacity ?? 100,
  };
}

function textProp(text: string, fontSize?: number): Record<string, unknown> {
  return { text, fontSize: fontSize ?? 20, fontFamily: FONT_FAMILIES.hand };
}

export function buildContainerSkeleton(
  type: "rectangle" | "ellipse" | "diamond",
  opts: ContainerOptions,
): Record<string, unknown> {
  const skeleton = baseSkeleton(type, opts);
  if (opts.width !== undefined) skeleton.width = opts.width;
  if (opts.height !== undefined) skeleton.height = opts.height;
  if (opts.round !== undefined && opts.round > 0) skeleton.roundness = { type: 3 };
  if (opts.text) skeleton.label = textProp(opts.text, opts.textFontSize);
  return skeleton;
}

export function buildTextSkeleton(opts: TextOptions): Record<string, unknown> {
  const fontFamily = FONT_FAMILIES[opts.fontFamily ?? "hand"];
  return {
    ...baseSkeleton("text", opts),
    text: opts.text,
    fontSize: opts.fontSize ?? 20,
    fontFamily,
    textAlign: opts.textAlign ?? "left",
  };
}

export function buildLineSkeleton(
  opts: BaseOptions & { points?: [number, number][] },
): Record<string, unknown> {
  const skeleton = baseSkeleton("line", opts);
  if (opts.points) skeleton.points = opts.points;
  return skeleton;
}

export function buildArrowSkeleton(opts: ArrowOptions): Record<string, unknown> {
  const skeleton = baseSkeleton("arrow", opts);
  if (opts.points) skeleton.points = opts.points;
  if (opts.from) skeleton.start = { id: opts.from };
  if (opts.to) skeleton.end = { id: opts.to };
  skeleton.startArrowhead = normalizeArrowhead(opts.startHead);
  skeleton.endArrowhead = normalizeArrowhead(opts.endHead) ?? "arrow";
  if (opts.text) skeleton.label = textProp(opts.text);
  return skeleton;
}

function normalizeArrowhead(value: string | undefined): string | null {
  if (!value || value === "none") return null;
  return value;
}

export function buildFreeDrawSkeleton(opts: FreeDrawOptions): Record<string, unknown> {
  return { ...baseSkeleton("freedraw", opts), points: opts.points, simulatePressure: true };
}

export function buildFrameSkeleton(opts: FrameOptions): Record<string, unknown> {
  const skeleton: Record<string, unknown> = { ...baseSkeleton("frame", opts) };
  if (opts.width !== undefined) skeleton.width = opts.width;
  if (opts.height !== undefined) skeleton.height = opts.height;
  if (opts.name) skeleton.name = opts.name;
  if (opts.children) skeleton.children = opts.children;
  return skeleton;
}

/**
 * Convert skeleton elements to full excalidraw elements using excalidraw's native API.
 * This handles proper arrow bindings, text positioning, and edge calculations.
 * Must be called within a jsdom context (use withDom wrapper).
 *
 * Only converts the provided skeletons — does NOT re-process existing file elements.
 * Returns just the newly created elements (to be appended to the file).
 *
 * When existingElements is provided, bound arrows can reference shapes in the existing
 * file. The existing elements are NOT re-processed, only used for arrow position calculation.
 */
export async function convertSkeletons(
  skeletons: Record<string, unknown>[],
  existingElements: ExcalidrawElement[] = [],
): Promise<ExcalidrawElement[]> {
  const { convertToExcalidrawElements } = await import("@excalidraw/element");

  // Pre-process: set arrow x/y between bound shapes so the converter
  // computes meaningful fixedPoint values for the binding.
  prepositionBoundArrows(skeletons, existingElements);

  // Save arrow binding refs before conversion. convertToExcalidrawElements only
  // receives new skeletons, so it can't resolve start/end references to shapes
  // that already exist in the file. We'll fix up missing bindings after conversion.
  const arrowBindingRefs = new Map<string, { startId?: string; endId?: string }>();
  for (const skel of skeletons) {
    if (skel.type !== "arrow") continue;
    const startRef = skel.start as { id: string } | undefined;
    const endRef = skel.end as { id: string } | undefined;
    if (startRef || endRef) {
      arrowBindingRefs.set(skel.id as string, { startId: startRef?.id, endId: endRef?.id });
    }
  }

  const result = convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  ) as unknown as ExcalidrawElement[];

  // Post-process: set baseline on text elements for correct export positioning.
  // @excalidraw/utils uses `baseline` for vertical text placement in both
  // SVG and canvas export. Computed via @napi-rs/canvas font metrics.
  for (const el of result) {
    if (el.type === "text" && (el.baseline === undefined || el.baseline === null)) {
      const fontSize = (el.fontSize as number) ?? 20;
      const fontFamily = String((el.fontFamily as number) ?? 5);
      const fontString = `${fontSize}px ${fontFamilyToName(fontFamily)}`;
      const ctx = createCanvas(1, 1).getContext("2d");
      ctx.font = fontString;
      const metrics = ctx.measureText("M");
      el.baseline = metrics.fontBoundingBoxAscent ?? fontSize * 0.85;
    }
  }

  // Post-process: create bindings for arrows that reference existing elements.
  // convertToExcalidrawElements only receives new skeletons, so it can't resolve
  // start/end refs to shapes already in the file — those arrows end up with
  // null startBinding/endBinding. Fix them up using the arrow geometry that
  // prepositionBoundArrows already computed.
  const allElements = [...existingElements, ...result];
  for (const el of result) {
    if (el.type !== "arrow") continue;
    const refs = arrowBindingRefs.get(el.id);
    if (!refs) continue;

    if (!el.startBinding && refs.startId) {
      const target = allElements.find((e) => e.id === refs.startId && !e.isDeleted);
      if (target) {
        el.startBinding = {
          elementId: refs.startId,
          fixedPoint: globalToFixedPoint(el.x, el.y, target),
          focus: 0,
          gap: 1,
        };
      }
    }

    if (!el.endBinding && refs.endId) {
      const target = allElements.find((e) => e.id === refs.endId && !e.isDeleted);
      if (target) {
        const points = el.points as [number, number][];
        const last = points[points.length - 1]!;
        el.endBinding = {
          elementId: refs.endId,
          fixedPoint: globalToFixedPoint(el.x + last[0], el.y + last[1], target),
          focus: 0,
          gap: 1,
        };
      }
    }
  }

  // Post-process: update arrow points to actually span between bound shapes.
  // convertToExcalidrawElements computes fixedPoint/binding metadata but leaves
  // arrow points at their default small size. We use the binding data to set
  // the correct arrow geometry.
  for (const el of result) {
    if (el.type !== "arrow") continue;
    repositionBoundArrow(el, allElements);
  }

  return result;
}

/** Set arrow x/y to right edge of start shape, pointing toward end shape center */
function prepositionBoundArrows(
  skeletons: Record<string, unknown>[],
  existingElements: ExcalidrawElement[],
): void {
  const allSkeletons = [...existingElements, ...skeletons];
  for (const skel of skeletons) {
    if (skel.type !== "arrow") continue;
    const startRef = skel.start as { id: string } | undefined;
    const endRef = skel.end as { id: string } | undefined;
    const startEl = startRef
      ? allSkeletons.find((e) => (e as Record<string, unknown>).id === startRef.id)
      : null;
    const endEl = endRef
      ? allSkeletons.find((e) => (e as Record<string, unknown>).id === endRef.id)
      : null;

    if (startEl && endEl) {
      const s = startEl as Record<string, unknown>;
      const e = endEl as Record<string, unknown>;
      const { sx, sy, ex, ey } = bestEdgeConnection(s, e);
      skel.x = sx;
      skel.y = sy;
      skel.points = [
        [0, 0],
        [ex - sx, ey - sy],
      ];
    }
  }
}

/** Convert a global coordinate to a fixedPoint [0-1, 0-1] relative to a shape's bounding box */
function globalToFixedPoint(
  globalX: number,
  globalY: number,
  shape: ExcalidrawElement,
): [number, number] {
  return [
    shape.width > 0 ? (globalX - shape.x) / shape.width : 0.5,
    shape.height > 0 ? (globalY - shape.y) / shape.height : 0.5,
  ];
}

/** Update arrow points to span between bound shapes using fixedPoint binding data */
export function repositionBoundArrow(
  arrow: ExcalidrawElement,
  allElements: readonly ExcalidrawElement[],
): void {
  type Binding = { elementId: string; fixedPoint: [number, number] } | null;
  const startBinding = arrow.startBinding as Binding;
  const endBinding = arrow.endBinding as Binding;
  if (!startBinding && !endBinding) return;

  const startEl = startBinding ? allElements.find((e) => e.id === startBinding.elementId) : null;
  const endEl = endBinding ? allElements.find((e) => e.id === endBinding.elementId) : null;

  const points = arrow.points as [number, number][];
  const lastPoint = points[points.length - 1]!;

  if (startEl && endEl) {
    // Both ends bound — reposition entire arrow
    const start = fixedPointToGlobal(startBinding!.fixedPoint, startEl);
    const end = fixedPointToGlobal(endBinding!.fixedPoint, endEl);
    arrow.x = start.x;
    arrow.y = start.y;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    arrow.points = [
      [0, 0],
      [dx, dy],
    ];
    arrow.width = Math.abs(dx);
    arrow.height = Math.abs(dy);
  } else if (startEl) {
    // Only start bound — move origin, keep free end at its global position
    const freeEndX = arrow.x + lastPoint[0];
    const freeEndY = arrow.y + lastPoint[1];
    const start = fixedPointToGlobal(startBinding!.fixedPoint, startEl);
    arrow.x = start.x;
    arrow.y = start.y;
    const dx = freeEndX - start.x;
    const dy = freeEndY - start.y;
    arrow.points = [
      [0, 0],
      [dx, dy],
    ];
    arrow.width = Math.abs(dx);
    arrow.height = Math.abs(dy);
  } else if (endEl) {
    // Only end bound — keep origin, update endpoint
    const end = fixedPointToGlobal(endBinding!.fixedPoint, endEl);
    const dx = end.x - arrow.x;
    const dy = end.y - arrow.y;
    arrow.points = [
      [0, 0],
      [dx, dy],
    ];
    arrow.width = Math.abs(dx);
    arrow.height = Math.abs(dy);
  }
}

/**
 * Determine the best edge connection points between two shapes.
 * Picks the closest pair of edge centers based on the relative position
 * of the shape centers (e.g., bottom→top for vertical flows, right→left for horizontal).
 */
function bestEdgeConnection(
  s: Record<string, unknown>,
  e: Record<string, unknown>,
): { sx: number; sy: number; ex: number; ey: number } {
  const sCx = (s.x as number) + (s.width as number) / 2;
  const sCy = (s.y as number) + (s.height as number) / 2;
  const eCx = (e.x as number) + (e.width as number) / 2;
  const eCy = (e.y as number) + (e.height as number) / 2;

  const dx = eCx - sCx;
  const dy = eCy - sCy;

  if (Math.abs(dx) > Math.abs(dy)) {
    // Horizontal: right→left or left→right
    if (dx > 0) {
      return { sx: (s.x as number) + (s.width as number), sy: sCy, ex: e.x as number, ey: eCy };
    }
    return { sx: s.x as number, sy: sCy, ex: (e.x as number) + (e.width as number), ey: eCy };
  }
  // Vertical: bottom→top or top→bottom
  if (dy > 0) {
    return { sx: sCx, sy: (s.y as number) + (s.height as number), ex: eCx, ey: e.y as number };
  }
  return { sx: sCx, sy: s.y as number, ex: eCx, ey: (e.y as number) + (e.height as number) };
}

function fixedPointToGlobal(fp: [number, number], el: ExcalidrawElement): { x: number; y: number } {
  return { x: el.x + el.width * fp[0], y: el.y + el.height * fp[1] };
}

/** Map excalidraw numeric font family IDs to CSS font names for metrics lookup */
function fontFamilyToName(id: string): string {
  switch (id) {
    case "1":
      return "Virgil";
    case "2":
      return "Helvetica";
    case "3":
      return "Cascadia";
    case "5":
      return "Excalifont";
    default:
      return "Virgil";
  }
}
