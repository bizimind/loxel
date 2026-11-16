import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";
import { bindLinearElement, redrawTextBoundingBox, Scene } from "@excalidraw/element";

import { withDom } from "../dom-shim.ts";
import { globalToFixedPoint } from "../elements/element-factory.ts";
import { generateElementId } from "../elements/element-id.ts";
import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import { skeletonsToElements } from "../elements/skeleton-converter.ts";
import { loadFile, saveFile } from "../file/excalidraw-file.ts";
import { MERMAID_DIAGRAM_TYPES } from "./mermaid-diagram-types.ts";
import { readStdinText } from "./stdin-ids.ts";

interface ImportMermaidResult {
  elementCount: number;
  elements: { id: string; type: string; text?: string }[];
}

export interface ImportMermaidOptions {
  x?: number;
  y?: number;
  /** Draw flowchart edges and state transitions curved instead of as elbow arrows. */
  curved?: boolean;
  json?: boolean;
}

function formatResult(r: ImportMermaidResult): string {
  const lines = [`Imported ${r.elementCount} elements from mermaid diagram:`];
  for (const el of r.elements) {
    const text = el.text ? ` "${el.text}"` : "";
    lines.push(`  ${el.type} ${el.id}${text}`);
  }
  return lines.join("\n");
}

const SUPPORTED_TYPES = `Supported diagram types: ${MERMAID_DIAGRAM_TYPES.join(", ")}.`;

export async function importMermaidCommand(
  filePath: string,
  opts: ImportMermaidOptions,
): Promise<void> {
  await runAction<ImportMermaidResult>(opts, async () => {
    const definition = await readStdinText();
    if (!definition.trim()) {
      throw new Error("No mermaid definition provided on stdin");
    }

    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    const { elements, files } = await convertMermaid(definition, { curved: opts.curved });

    // Merge binary files (images) if any
    if (files) Object.assign(file.files, files);

    const dx = opts.x ?? 0;
    const dy = opts.y ?? 0;
    for (const el of elements) {
      el.x += dx;
      el.y += dy;
    }

    file.elements.push(...elements);
    await saveFile(resolved, file);

    // Build summary — show containers/shapes but not bound text elements
    const summary = elements
      .filter((el) => el.type !== "text" || !el.containerId)
      .map((el) => {
        const text =
          el.type === "text"
            ? (el.text as string)
            : ((el.originalText as string | undefined) ?? findBoundText(elements, el.id));
        return { id: el.id, type: el.type, text: text || undefined };
      });

    return createResult<ImportMermaidResult>(
      { elementCount: elements.length, elements: summary },
      formatResult,
    );
  });
}

/**
 * Convert a Mermaid definition to Excalidraw elements laid out by
 * mermaid-to-excalidraw (which lays diagrams out with Pele), with arrows bound
 * to the shapes they connect. Node IDs from the definition become element IDs.
 */
export async function convertMermaid(
  definition: string,
  opts: { curved?: boolean } = {},
): Promise<{ elements: ExcalidrawElement[]; files: Record<string, unknown> | undefined }> {
  return withDom(async () => {
    const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");

    let parsed: Awaited<ReturnType<typeof parseMermaidToExcalidraw>>;
    try {
      parsed = await parseMermaidToExcalidraw(definition, { elbow: !opts.curved });
    } catch (err) {
      throw parseError(err);
    }
    const skeletons = parsed.elements as unknown as Record<string, unknown>[];

    // Diagram types the library can't convert come back as a single rasterized
    // image, which isn't editable.
    if (skeletons.every((s) => s.type === "image")) {
      throw new Error(
        `This mermaid diagram type converts to an image, not editable elements. ${SUPPORTED_TYPES}`,
      );
    }

    // Class, ER and timeline relations come without IDs; name them so they can
    // be found again to bind once converted.
    for (const skel of skeletons) {
      if (skel.type === "arrow" && typeof skel.id !== "string") skel.id = generateElementId();
    }

    const elements = skeletonsToElements(skeletons);
    const scene = new Scene(elements as unknown as SceneElement[]);
    fitContainersToLabels(elements, scene);
    bindArrows(skeletons, scene);
    for (const el of elements) {
      // The Scene numbers elements with fractional indices. Files written by this
      // CLI carry none (Excalidraw assigns them on load), so drop them again.
      el.index = null;
      if (el.type === "arrow" && el.elbowed !== true) addStraightArrowFixedPoints(el, elements);
    }
    return { elements, files: parsed.files };
  });
}

/** Describe a mermaid-to-excalidraw parse error (a `PeleError`, coded "syntax", "semantic", ...). */
function parseError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  const hint = code === "unsupported-diagram" ? ` ${SUPPORTED_TYPES}` : "";
  return new Error(`Invalid mermaid definition: ${message}${hint}`, { cause: err });
}

type SceneElement = Parameters<typeof bindLinearElement>[1];

/**
 * Fit labels to their containers as Excalidraw does when it lays out bound
 * text: wrap a label wider than the room its container gives it (a diamond or
 * an ellipse gives less than its size), then grow the container if the wrapped
 * label is still too tall or a word too wide. Pele sizes nodes for their labels
 * in Excalifont, so this matters mostly for diamonds. Excalidraw grows a
 * container from its top-left corner; it's moved back to its center here, where
 * Pele's arrows meet it.
 */
function fitContainersToLabels(elements: ExcalidrawElement[], scene: Scene): void {
  const byId = scene.getNonDeletedElementsMap();
  for (const el of elements) {
    if (el.type !== "text" || typeof el.containerId !== "string") continue;
    const container = byId.get(el.containerId);
    if (!container || container.type === "arrow") continue;
    const text = byId.get(el.id) as Parameters<typeof redrawTextBoundingBox>[0];

    const { width, height } = container;
    redrawTextBoundingBox(text, container, scene);
    if (container.width === width && container.height === height) continue;
    scene.mutateElement(container, {
      x: container.x - (container.width - width) / 2,
      y: container.y - (container.height - height) / 2,
    });
    redrawTextBoundingBox(text, container, scene);
  }
}

/**
 * Bind arrows to the shapes their skeletons start and end at, the way Excalidraw
 * binds a dropped arrow end (its own skeleton conversion does the same): focus
 * and gap from where the arrow touches the shape, and, for elbow arrows, the
 * fixed point they're routed from when a shape moves. Curved arrows keep the
 * points Pele routed them along; Excalidraw re-routes elbow arrows as it binds
 * them, keeping the segments Pele fixed.
 */
function bindArrows(skeletons: Record<string, unknown>[], scene: Scene): void {
  type SceneArrow = Parameters<typeof bindLinearElement>[0];
  const byId = scene.getNonDeletedElementsMap();
  for (const skel of skeletons) {
    if (skel.type !== "arrow" || typeof skel.id !== "string") continue;
    const arrow = byId.get(skel.id) as SceneArrow | undefined;
    if (!arrow) continue;
    for (const end of ["start", "end"] as const) {
      const shape = byId.get(skeletonRefId(skel[end]) ?? "");
      if (shape) bindLinearElement(arrow, shape as SceneElement, end, scene);
    }
  }
}

function skeletonRefId(ref: unknown): string | undefined {
  if (typeof ref !== "object" || ref === null || !("id" in ref)) return undefined;
  return typeof ref.id === "string" ? ref.id : undefined;
}

/**
 * Excalidraw binds non-elbow arrows by focus and gap only. This CLI's `move`
 * re-attaches bound arrows by `fixedPoint` (as arrows drawn with `draw arrow
 * --from/--to` carry), so record where each end touches its shape.
 */
function addStraightArrowFixedPoints(
  arrow: ExcalidrawElement,
  elements: ExcalidrawElement[],
): void {
  const points = arrow.points as [number, number][];
  const last = points[points.length - 1]!;
  const ends = [
    ["startBinding", arrow.x, arrow.y],
    ["endBinding", arrow.x + last[0], arrow.y + last[1]],
  ] as const;
  for (const [key, x, y] of ends) {
    const binding = arrow[key] as { elementId: string; fixedPoint?: unknown } | null;
    const shape = binding && elements.find((el) => el.id === binding.elementId);
    if (binding && shape) binding.fixedPoint = globalToFixedPoint(x, y, shape);
  }
}

function findBoundText(elements: ExcalidrawElement[], containerId: string): string | undefined {
  const textEl = elements.find((el) => el.type === "text" && el.containerId === containerId);
  return textEl ? (textEl.text as string) : undefined;
}
