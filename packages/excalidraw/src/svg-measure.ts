/**
 * SVG measurement module — provides accurate getBBox, getComputedTextLength,
 * getBoundingClientRect, and getComputedStyle for SVG elements in linkedom.
 *
 * Text measurement uses @napi-rs/canvas with registered fonts.
 * Path bounding boxes use svg-path-bbox (pure geometry).
 * Shape elements read dimensions from SVG attributes.
 * Transform chains are accumulated from parent elements.
 */
import { svgPathBbox } from "svg-path-bbox";

import { createCanvas } from "./canvas-loader.ts";

// ---------- Types ----------

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Flat 2D affine matrix [a, b, c, d, e, f] matching SVG matrix(a,b,c,d,e,f) */
type Matrix = [number, number, number, number, number, number];

// ---------- Canvas context for text measurement ----------

let _measureCtx: ReturnType<ReturnType<typeof createCanvas>["getContext"]> = null;

function measureCtx() {
  if (!_measureCtx) {
    _measureCtx = createCanvas(1, 1).getContext("2d");
  }
  return _measureCtx;
}

// ---------- Font resolution ----------

/** Resolve CSS font string from an SVG element by walking attributes + parents. */
function resolveFont(el: Element): string {
  let fontSize = "16px";
  let fontFamily = "sans-serif";

  let node: Element | null = el;
  let foundSize = false;
  let foundFamily = false;

  while (node && (!foundSize || !foundFamily)) {
    if (!foundSize) {
      const fs = node.getAttribute("font-size") ?? (node as HTMLElement).style?.fontSize;
      if (fs) {
        fontSize = fs.includes("px") ? fs : `${fs}px`;
        foundSize = true;
      }
    }
    if (!foundFamily) {
      const ff = node.getAttribute("font-family") ?? (node as HTMLElement).style?.fontFamily;
      if (ff) {
        fontFamily = ff;
        foundFamily = true;
      }
    }
    node = node.parentElement;
  }

  return `${fontSize} ${fontFamily}`;
}

// ---------- Transform parsing ----------

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Parse a single SVG transform function into a matrix. */
function parseSingleTransform(fn: string, args: number[]): Matrix {
  switch (fn) {
    case "translate":
      return [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    case "scale": {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      return [sx, 0, 0, sy, 0, 0];
    }
    case "rotate": {
      const deg = args[0] ?? 0;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      if (args.length >= 3) {
        const cx = args[1]!;
        const cy = args[2]!;
        // rotate around point: translate(cx,cy) rotate(a) translate(-cx,-cy)
        return [cos, sin, -sin, cos, cx * (1 - cos) + cy * sin, cy * (1 - cos) - cx * sin];
      }
      return [cos, sin, -sin, cos, 0, 0];
    }
    case "matrix":
      return [args[0] ?? 1, args[1] ?? 0, args[2] ?? 0, args[3] ?? 1, args[4] ?? 0, args[5] ?? 0];
    case "skewX": {
      const rad = ((args[0] ?? 0) * Math.PI) / 180;
      return [1, 0, Math.tan(rad), 1, 0, 0];
    }
    case "skewY": {
      const rad = ((args[0] ?? 0) * Math.PI) / 180;
      return [1, Math.tan(rad), 0, 1, 0, 0];
    }
    default:
      return IDENTITY;
  }
}

const TRANSFORM_RE = /(\w+)\s*\(([^)]*)\)/g;

/** Parse a full SVG transform attribute string into a combined matrix. */
function parseTransformAttr(attr: string): Matrix {
  let result: Matrix = IDENTITY;
  let match: RegExpExecArray | null;
  TRANSFORM_RE.lastIndex = 0;
  while ((match = TRANSFORM_RE.exec(attr)) !== null) {
    const fn = match[1]!;
    const args = match[2]!
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    result = multiply(result, parseSingleTransform(fn, args));
  }
  return result;
}

/** Accumulate transforms from element up to (but not including) the root SVG. */
function accumulateTransforms(el: Element): Matrix {
  let matrix: Matrix = IDENTITY;
  let node: Element | null = el;
  while (node) {
    const attr = node.getAttribute("transform");
    if (attr) {
      // Pre-multiply: parent transforms apply first
      matrix = multiply(parseTransformAttr(attr), matrix);
    }
    node = node.parentElement;
  }
  return matrix;
}

/** Transform a bounding box through an affine matrix. */
function transformBBox(bbox: BBox, m: Matrix): BBox {
  // Transform all 4 corners and take the axis-aligned bounding box
  const corners = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x, bbox.y + bbox.height],
    [bbox.x + bbox.width, bbox.y + bbox.height],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of corners) {
    const tx = m[0] * cx! + m[2] * cy! + m[4];
    const ty = m[1] * cx! + m[3] * cy! + m[5];
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------- Per-element bbox computation ----------

function attr(el: Element, name: string): number {
  return parseFloat(el.getAttribute(name) ?? "") || 0;
}

function computeTextBBox(el: Element): BBox {
  const ctx = measureCtx();
  const font = resolveFont(el);
  ctx.font = font;
  const text = el.textContent ?? "";
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  const metrics = ctx.measureText(lines[0] || "M");
  const ascent = metrics.fontBoundingBoxAscent ?? 0;
  const descent = metrics.fontBoundingBoxDescent ?? 0;
  const lineHeight = ascent + descent;
  const height = lineHeight * lines.length;
  const x = attr(el, "x");
  const y = attr(el, "y") - ascent; // SVG text y is baseline
  return { x, y, width, height };
}

function computePathBBox(el: Element): BBox {
  const d = el.getAttribute("d");
  if (!d) return { x: 0, y: 0, width: 0, height: 0 };
  try {
    const [minX, minY, maxX, maxY] = svgPathBbox(d);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  } catch (e) {
    process.stderr.write(`[svg-measure] svgPathBbox failed for path: ${d.slice(0, 80)} ${e}\n`);
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function computeChildrenBBox(el: Element): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasChildren = false;

  for (const child of Array.from(el.children)) {
    const childBBox = computeLocalBBox(child);
    // Apply child's own transform
    const childTransform = child.getAttribute("transform");
    const transformed = childTransform
      ? transformBBox(childBBox, parseTransformAttr(childTransform))
      : childBBox;

    if (transformed.width > 0 || transformed.height > 0) {
      hasChildren = true;
      minX = Math.min(minX, transformed.x);
      minY = Math.min(minY, transformed.y);
      maxX = Math.max(maxX, transformed.x + transformed.width);
      maxY = Math.max(maxY, transformed.y + transformed.height);
    }
  }

  if (!hasChildren) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Compute the local bounding box of an SVG element (without parent transforms).
 * This is the SVG spec getBBox() — the element's own geometry in its local coordinate space.
 */
function computeLocalBBox(el: Element): BBox {
  const tag = el.localName ?? (el.tagName || "").toLowerCase();

  switch (tag) {
    case "text":
    case "tspan":
      return computeTextBBox(el);

    case "path":
      return computePathBBox(el);

    case "rect":
      return {
        x: attr(el, "x"),
        y: attr(el, "y"),
        width: attr(el, "width"),
        height: attr(el, "height"),
      };

    case "circle": {
      const cx = attr(el, "cx");
      const cy = attr(el, "cy");
      const r = attr(el, "r");
      return { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r };
    }

    case "ellipse": {
      const cx = attr(el, "cx");
      const cy = attr(el, "cy");
      const rx = attr(el, "rx");
      const ry = attr(el, "ry");
      return { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry };
    }

    case "line": {
      const x1 = attr(el, "x1");
      const y1 = attr(el, "y1");
      const x2 = attr(el, "x2");
      const y2 = attr(el, "y2");
      const minX = Math.min(x1, x2);
      const minY = Math.min(y1, y2);
      return { x: minX, y: minY, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }

    case "polygon":
    case "polyline": {
      const points = el.getAttribute("points");
      if (!points) return { x: 0, y: 0, width: 0, height: 0 };
      const nums = points
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < nums.length - 1; i += 2) {
        minX = Math.min(minX, nums[i]!);
        minY = Math.min(minY, nums[i + 1]!);
        maxX = Math.max(maxX, nums[i]!);
        maxY = Math.max(maxY, nums[i + 1]!);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    case "defs":
    case "symbol":
      // Definition containers are invisible — their content is only rendered via <use>
      return { x: 0, y: 0, width: 0, height: 0 };

    case "use": {
      // <use> references another element; approximate from its own attributes
      const ux = attr(el, "x");
      const uy = attr(el, "y");
      const uw = attr(el, "width");
      const uh = attr(el, "height");
      return { x: ux, y: uy, width: uw, height: uh };
    }

    case "g":
    case "svg":
    case "marker":
      return computeChildrenBBox(el);

    case "foreignobject":
      return {
        x: attr(el, "x"),
        y: attr(el, "y"),
        width: attr(el, "width"),
        height: attr(el, "height"),
      };

    default:
      // Unknown element — try children, fall back to zero
      if (el.children.length > 0) return computeChildrenBBox(el);
      return { x: 0, y: 0, width: 0, height: 0 };
  }
}

// ---------- Public API ----------

/**
 * Compute getBBox() for an SVG element — the element's own geometry
 * in its local coordinate space (no parent transforms applied).
 * Matches the SVG spec: https://developer.mozilla.org/en-US/docs/Web/API/SVGGraphicsElement/getBBox
 */
export function computeBBox(el: Element): BBox {
  return computeLocalBBox(el);
}

/**
 * Compute getBoundingClientRect() — getBBox with all ancestor transforms applied.
 * In our headless context there's no viewport, so this is the global SVG coordinate bbox.
 *
 * For HTML elements inside foreignObject (e.g., mermaid label divs), we measure
 * text content with canvas since SVG bbox computation doesn't apply.
 */
export function computeClientRect(
  el: Element,
): BBox & { top: number; left: number; bottom: number; right: number } {
  let bbox: BBox;

  // HTML elements inside foreignObject: use text measurement instead of SVG bbox.
  // Mermaid creates <div>s inside <foreignObject> for node labels and reads their
  // getBoundingClientRect to size the nodes.
  const tag = el.localName ?? (el.tagName || "").toLowerCase();
  if (tag === "div" || tag === "span" || tag === "p" || tag === "foreignobject") {
    const text = el.textContent ?? "";
    if (text) {
      const ctx = measureCtx();
      const font = resolveFont(el);
      ctx.font = font;
      const lines = text.split("\n");
      const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
      const metrics = ctx.measureText(lines[0] || "M");
      const lineHeight =
        (metrics.fontBoundingBoxAscent ?? 0) + (metrics.fontBoundingBoxDescent ?? 0);
      const height = lineHeight * lines.length;
      bbox = { x: 0, y: 0, width, height };
    } else {
      bbox = { x: 0, y: 0, width: 0, height: 0 };
    }
  } else {
    const local = computeLocalBBox(el);
    const matrix = accumulateTransforms(el);
    const isIdentity =
      matrix[0] === 1 &&
      matrix[1] === 0 &&
      matrix[2] === 0 &&
      matrix[3] === 1 &&
      matrix[4] === 0 &&
      matrix[5] === 0;
    bbox = isIdentity ? local : transformBBox(local, matrix);
  }

  return {
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
    top: bbox.y,
    left: bbox.x,
    bottom: bbox.y + bbox.height,
    right: bbox.x + bbox.width,
  };
}

/**
 * Compute getComputedTextLength() for an SVG text/tspan element.
 */
export function computeTextLength(el: Element): number {
  const ctx = measureCtx();
  ctx.font = resolveFont(el);
  return ctx.measureText(el.textContent ?? "").width;
}

/** Convert camelCase to kebab-case for CSS property lookup. */
function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Create a getComputedStyle-like proxy for an SVG element.
 * Reads inline style, then SVG presentation attributes, then inherits up the tree.
 */
export function createComputedStyle(el: Element): CSSStyleDeclaration {
  return new Proxy({} as CSSStyleDeclaration, {
    get(_, prop: string) {
      if (prop === "getPropertyValue") {
        return (name: string) => {
          const style = (el as HTMLElement).style;
          return style?.[name as keyof CSSStyleDeclaration] ?? el.getAttribute(name) ?? "";
        };
      }
      // Map common CSS properties to SVG attributes
      const kebab = camelToKebab(prop);
      const style = (el as HTMLElement).style;
      const fromStyle = style?.[prop as keyof CSSStyleDeclaration];
      if (fromStyle) return String(fromStyle);
      const fromAttr = el.getAttribute(kebab);
      if (fromAttr) return fromAttr;
      // Inherit font properties from parents
      if (
        prop === "fontSize" ||
        prop === "fontFamily" ||
        prop === "fontWeight" ||
        prop === "fontStyle"
      ) {
        let node: Element | null = el.parentElement;
        while (node) {
          const val =
            node.getAttribute(kebab) ??
            (node as HTMLElement).style?.[prop as keyof CSSStyleDeclaration];
          if (val) return String(val);
          node = node.parentElement;
        }
        if (prop === "fontSize") return "16px";
        if (prop === "fontFamily") return "sans-serif";
      }
      return "";
    },
  });
}
