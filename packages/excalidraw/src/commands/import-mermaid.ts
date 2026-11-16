import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { withDom } from "../dom-shim.ts";
import { globalToFixedPoint } from "../elements/element-factory.ts";
import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import { fitContainerToBoundText, skeletonsToElements } from "../elements/skeleton-converter.ts";
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

    const elements = skeletonsToElements(skeletons);
    fitContainersToLabels(elements);
    await bindArrows(elements, skeletons);
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

/**
 * Grow containers whose label doesn't fit the space Excalidraw gives it. Pele
 * sizes nodes for their labels in Excalifont, but a diamond's or an ellipse's
 * label gets less room in Excalidraw than in Pele's shapes, so Excalidraw
 * would wrap it.
 */
function fitContainersToLabels(elements: ExcalidrawElement[]): void {
  const byId = new Map(elements.map((el) => [el.id, el]));
  for (const text of elements) {
    if (text.type !== "text" || typeof text.containerId !== "string") continue;
    const container = byId.get(text.containerId);
    if (container && container.type !== "arrow") fitContainerToBoundText(container, text);
  }
}

/**
 * Bind arrows to the shapes their skeletons start and end at, the way Excalidraw
 * binds a dropped arrow end (its own skeleton conversion does the same): focus
 * and gap from where the arrow touches the shape, and, for elbow arrows, the
 * fixed point they're routed from when a shape moves. Arrows keep the points
 * Pele routed them along.
 */
async function bindArrows(
  elements: ExcalidrawElement[],
  skeletons: Record<string, unknown>[],
): Promise<void> {
  const { Scene, bindLinearElement } = await import("@excalidraw/element");
  type SceneElement = Parameters<typeof bindLinearElement>[1];
  type SceneArrow = Parameters<typeof bindLinearElement>[0];

  const scene = new Scene(elements as unknown as SceneElement[]);
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

  for (const el of elements) {
    // The Scene numbers elements with fractional indices. Files written by this
    // CLI carry none (Excalidraw assigns them on load), so drop them again.
    el.index = null;
    if (el.type === "arrow" && el.elbowed !== true) addStraightArrowFixedPoints(el, elements);
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
