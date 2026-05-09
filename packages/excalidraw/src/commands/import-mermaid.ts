import { createResult, runAction } from "@bizimind/cli-common";
import path from "node:path";

import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";

import { createCanvas } from "../canvas-loader.ts";
import { withDom } from "../dom-shim.ts";
import { FONT_FAMILIES } from "../elements/element-defaults.ts";
import { loadFile, saveFile } from "../file/excalidraw-file.ts";
import { readStdinText } from "./stdin-ids.ts";

interface ImportMermaidResult {
  elementCount: number;
  elements: { id: string; type: string; text?: string }[];
}

function formatResult(r: ImportMermaidResult): string {
  const lines = [`Imported ${r.elementCount} elements from mermaid diagram:`];
  for (const el of r.elements) {
    const text = el.text ? ` "${el.text}"` : "";
    lines.push(`  ${el.type} ${el.id}${text}`);
  }
  return lines.join("\n");
}

export async function importMermaidCommand(
  filePath: string,
  opts: { x?: number; y?: number; json?: boolean },
): Promise<void> {
  await runAction<ImportMermaidResult>(opts, async () => {
    const definition = await readStdinText();
    if (!definition.trim()) {
      throw new Error("No mermaid definition provided on stdin");
    }

    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    const elements = await withDom(async () => {
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");

      const { elements: skeletons, files } = await parseMermaidToExcalidraw(definition);

      // Check if the result contains image fallbacks (non-flowchart diagram types).
      // The library renders unsupported types (sequence, class, ER, etc.) as rasterized
      // images rather than native elements — these aren't useful for editing.
      const hasImageFallback = skeletons.some(
        (s: Record<string, unknown>) => s.type === "image" || (s as Record<string, unknown>).fileId,
      );
      if (hasImageFallback && skeletons.length <= 2) {
        throw new Error(
          "This diagram type was converted to an image, not editable elements. " +
            "Only flowchart/graph diagrams produce native elements. " +
            "Use 'flowchart TD' or 'graph TD' syntax.",
        );
      }

      // Merge binary files (images) if any
      if (files && Object.keys(files).length > 0) {
        Object.assign(file.files, files);
      }

      // Mermaid sizes containers based on its own font (16px sans-serif), but
      // excalidraw renders bound text in Virgil/Excalifont at the label's fontSize
      // (default 20px) with ~50px internal padding. Widen containers so text doesn't wrap.
      ensureContainersFitText(skeletons as Record<string, unknown>[]);

      // Use convertToExcalidrawElements to preserve mermaid's multi-point arrow
      // paths that route around obstacles. Then fix up any out-of-range fixedPoint
      // values in bindings (mermaid's arrow positions don't always align precisely
      // with shape edges, producing fixedPoints outside 0-1 that excalidraw treats
      // as unbound).
      const { convertToExcalidrawElements } = await import("@excalidraw/element");
      const converted = convertToExcalidrawElements(
        skeletons as Parameters<typeof convertToExcalidrawElements>[0],
        { regenerateIds: false },
      ) as unknown as ExcalidrawElement[];

      fixArrowBindings(converted);
      return converted;
    });

    // Apply offset
    const dx = opts.x ?? 0;
    const dy = opts.y ?? 0;
    if (dx !== 0 || dy !== 0) {
      for (let i = 0; i < elements.length; i++) {
        elements[i] = { ...elements[i]!, x: elements[i]!.x + dx, y: elements[i]!.y + dy };
      }
    }

    file.elements.push(...elements);
    await saveFile(resolved, file);

    // Build summary — show containers/shapes but not bound text elements
    const summary = elements
      .filter((el) => {
        if (el.type === "text") {
          // Filter out bound text (attached to containers) — only show standalone text
          const containerId = (el as Record<string, unknown>).containerId;
          return !containerId;
        }
        return true;
      })
      .map((el) => {
        const text =
          el.type === "text"
            ? ((el as Record<string, unknown>).text as string)
            : (((el as Record<string, unknown>).originalText as string | undefined) ??
              findBoundText(elements, el.id));
        return { id: el.id, type: el.type, text: text || undefined };
      });

    return createResult<ImportMermaidResult>(
      { elementCount: elements.length, elements: summary },
      formatResult,
    );
  });
}

function findBoundText(elements: ExcalidrawElement[], containerId: string): string | undefined {
  const textEl = elements.find(
    (el) => el.type === "text" && (el as Record<string, unknown>).containerId === containerId,
  );
  return textEl ? ((textEl as Record<string, unknown>).text as string) : undefined;
}

/**
 * Fix arrow bindings so arrows physically connect to shape edges.
 *
 * convertToExcalidrawElements creates binding metadata but with imprecise
 * fixedPoints (e.g., 0.89 instead of 1.0) because mermaid's arrow positions
 * don't align with shape edges. Excalidraw requires arrow endpoints to
 * physically touch the shape at the fixedPoint position.
 *
 * This function:
 * 1. Snaps fixedPoint values to exact edge values (0 or 1) based on which
 *    edge the arrow approaches from
 * 2. Repositions arrow start/end points to the snapped edge position
 * 3. Preserves intermediate waypoints for mermaid's curved arrow paths
 */
function fixArrowBindings(elements: ExcalidrawElement[]): void {
  const byId = new Map(elements.map((el) => [el.id, el]));

  for (const el of elements) {
    if (el.type !== "arrow") continue;
    const arrow = el as Record<string, unknown>;
    const points = arrow.points as [number, number][];
    if (!points || points.length < 2) continue;

    for (const [bindingKey, pointIdx] of [
      ["startBinding", 0],
      ["endBinding", points.length - 1],
    ] as const) {
      const binding = arrow[bindingKey] as
        | { elementId?: string; fixedPoint?: [number, number] }
        | null
        | undefined;
      if (!binding?.fixedPoint || !binding.elementId) continue;

      const target = byId.get(binding.elementId);
      if (!target) continue;

      // Snap fixedPoint to nearest edge. The arrow should connect at a shape
      // border, not at some interior point. Determine which edge based on
      // which fixedPoint axis is closest to 0 or 1.
      const [fpx, fpy] = binding.fixedPoint;
      const distToLeft = fpx;
      const distToRight = 1 - fpx;
      const distToTop = fpy;
      const distToBottom = 1 - fpy;
      const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);

      let snappedX: number;
      let snappedY: number;
      if (minDist === distToRight) {
        snappedX = 1;
        snappedY = Math.max(0, Math.min(1, fpy));
      } else if (minDist === distToLeft) {
        snappedX = 0;
        snappedY = Math.max(0, Math.min(1, fpy));
      } else if (minDist === distToBottom) {
        snappedX = Math.max(0, Math.min(1, fpx));
        snappedY = 1;
      } else {
        snappedX = Math.max(0, Math.min(1, fpx));
        snappedY = 0;
      }
      binding.fixedPoint = [snappedX, snappedY];

      // Compute global position from snapped fixedPoint
      const globalX = target.x + snappedX * target.width;
      const globalY = target.y + snappedY * target.height;

      if (pointIdx === 0) {
        // Move arrow origin to the start binding point; shift all other points
        const dx = globalX - (arrow.x as number);
        const dy = globalY - (arrow.y as number);
        arrow.x = globalX;
        arrow.y = globalY;
        for (let i = 1; i < points.length; i++) {
          points[i] = [points[i]![0] - dx, points[i]![1] - dy];
        }
      } else {
        // Move last point to the end binding point (relative to arrow origin)
        points[pointIdx] = [globalX - (arrow.x as number), globalY - (arrow.y as number)];
      }
    }

    // Recompute width/height from points
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    arrow.width = maxX - minX;
    arrow.height = maxY - minY;
  }
}

// Excalidraw font name map: family ID → canvas font name
const FONT_NAMES: Record<number, string> = {
  [FONT_FAMILIES.hand]: "Virgil",
  [FONT_FAMILIES.normal]: "Helvetica",
  [FONT_FAMILIES.code]: "Cascadia",
};
/** Horizontal padding excalidraw reserves inside containers for bound text. */
const CONTAINER_TEXT_PADDING = 50;

/**
 * Widen mermaid skeleton containers so their label text fits after excalidraw conversion.
 *
 * Mermaid measures text at ~16px sans-serif, but excalidraw renders bound text
 * in Virgil at the label's fontSize (default 20px) which is significantly wider.
 * Without this adjustment, long labels wrap their last few characters.
 */
function ensureContainersFitText(skeletons: Record<string, unknown>[]): void {
  const ctx = createCanvas(1, 1).getContext("2d");

  for (const skel of skeletons) {
    const label = skel.label as
      | { text?: string; fontSize?: number; fontFamily?: number }
      | undefined;
    if (!label?.text || skel.width === undefined || skel.width === null) continue;

    const fontSize = label.fontSize ?? 20;
    const fontFamily = label.fontFamily ?? FONT_FAMILIES.hand;
    const fontName = FONT_NAMES[fontFamily] ?? "Virgil";
    ctx.font = `${fontSize}px ${fontName}`;

    const lines = label.text.split("\n");
    const maxLineWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const minWidth = Math.ceil(maxLineWidth) + CONTAINER_TEXT_PADDING;

    if ((skel.width as number) < minWidth) {
      skel.width = minWidth;
    }
  }
}
