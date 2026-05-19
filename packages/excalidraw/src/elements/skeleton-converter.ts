import type { ElementConstructorOpts } from "@excalidraw/element";

import {
  newArrowElement,
  newElement,
  newFreeDrawElement,
  newFrameElement,
  newImageElement,
  newLinearElement,
  newMagicFrameElement,
  newTextElement,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "./excalidraw-types.ts";

import { generateElementId } from "./element-id.ts";

/**
 * Convert skeleton objects to full excalidraw elements using individual factory functions.
 *
 * Replaces the removed `convertToExcalidrawElements` API. Handles:
 * - Dispatching to the correct factory based on element type
 * - Creating bound text elements from container `label` properties
 * - Preserving custom IDs when provided
 *
 * Must be called within a DOM context (use withDom wrapper) since text
 * measurement requires document.createElement.
 */
export function skeletonsToElements(skeletons: Record<string, unknown>[]): ExcalidrawElement[] {
  const results: ExcalidrawElement[] = [];

  for (const skel of skeletons) {
    const type = skel.type as string;
    const opts = buildOpts(skel);

    switch (type) {
      case "rectangle":
      case "ellipse":
      case "diamond": {
        const el = newElement({ ...opts, type });
        results.push(el as unknown as ExcalidrawElement);
        maybeCreateBoundText(skel, el as unknown as ExcalidrawElement, results);
        break;
      }

      case "text": {
        const el = newTextElement({
          ...opts,
          text: (skel.text as string) ?? "",
          originalText: skel.originalText as string | undefined,
          fontSize: skel.fontSize as number | undefined,
          fontFamily: skel.fontFamily as Parameters<typeof newTextElement>[0]["fontFamily"],
          textAlign: skel.textAlign as Parameters<typeof newTextElement>[0]["textAlign"],
          verticalAlign: skel.verticalAlign as Parameters<
            typeof newTextElement
          >[0]["verticalAlign"],
          containerId: skel.containerId as string | null | undefined,
          lineHeight: skel.lineHeight as Parameters<typeof newTextElement>[0]["lineHeight"],
          autoResize: skel.autoResize as boolean | undefined,
        });
        results.push(el as unknown as ExcalidrawElement);
        break;
      }

      case "arrow": {
        const el = newArrowElement({
          ...opts,
          type: "arrow" as const,
          startArrowhead: (skel.startArrowhead ?? null) as Parameters<
            typeof newArrowElement
          >[0]["startArrowhead"],
          endArrowhead: (skel.endArrowhead ?? "arrow") as Parameters<
            typeof newArrowElement
          >[0]["endArrowhead"],
          points: skel.points as Parameters<typeof newArrowElement>[0]["points"],
        });
        results.push(el as unknown as ExcalidrawElement);
        maybeCreateBoundText(skel, el as unknown as ExcalidrawElement, results);
        break;
      }

      case "line": {
        const el = newLinearElement({
          ...opts,
          type: "line" as const,
          points: skel.points as Parameters<typeof newLinearElement>[0]["points"],
        });
        results.push(el as unknown as ExcalidrawElement);
        break;
      }

      case "freedraw": {
        const el = newFreeDrawElement({
          ...opts,
          type: "freedraw" as const,
          points: skel.points as Parameters<typeof newFreeDrawElement>[0]["points"],
          simulatePressure: (skel.simulatePressure as boolean) ?? true,
          pressures: skel.pressures as Parameters<typeof newFreeDrawElement>[0]["pressures"],
        });
        results.push(el as unknown as ExcalidrawElement);
        break;
      }

      case "frame": {
        const el = newFrameElement({ ...opts, name: skel.name as string | undefined });
        results.push(el as unknown as ExcalidrawElement);
        break;
      }

      case "magicframe": {
        const el = newMagicFrameElement({ ...opts, name: skel.name as string | undefined });
        results.push(el as unknown as ExcalidrawElement);
        break;
      }

      case "image": {
        const el = newImageElement({
          ...opts,
          type: "image" as const,
          fileId: skel.fileId as Parameters<typeof newImageElement>[0]["fileId"],
          status: skel.status as Parameters<typeof newImageElement>[0]["status"],
          scale: skel.scale as Parameters<typeof newImageElement>[0]["scale"],
          crop: skel.crop as Parameters<typeof newImageElement>[0]["crop"],
        });
        results.push(el as unknown as ExcalidrawElement);
        break;
      }

      default:
        // For unknown types, create as generic element
        results.push({
          ...skel,
          isDeleted: false,
          width: (skel.width as number) ?? 0,
          height: (skel.height as number) ?? 0,
        } as ExcalidrawElement);
    }
  }

  return results;
}

/**
 * Extract common ElementConstructorOpts from a skeleton object.
 * The `id` field is accepted at runtime by all factory functions even though
 * it's omitted from the ElementConstructorOpts type definition.
 */
function buildOpts(skel: Record<string, unknown>): ElementConstructorOpts & { id?: string } {
  const opts: Record<string, unknown> = { x: (skel.x as number) ?? 0, y: (skel.y as number) ?? 0 };

  // Pass through optional properties that factory functions accept
  const passthrough = [
    "id",
    "width",
    "height",
    "angle",
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "strokeWidth",
    "strokeStyle",
    "roughness",
    "opacity",
    "roundness",
    "groupIds",
    "frameId",
    "index",
    "boundElements",
    "seed",
    "version",
    "versionNonce",
    "link",
    "locked",
    "customData",
  ] as const;

  for (const key of passthrough) {
    if (skel[key] !== undefined) {
      opts[key] = skel[key];
    }
  }

  return opts as ElementConstructorOpts & { id?: string };
}

/**
 * If the skeleton has a `label` property, create a bound text element
 * and set up the bidirectional binding between container and text.
 */
function maybeCreateBoundText(
  skel: Record<string, unknown>,
  container: ExcalidrawElement,
  results: ExcalidrawElement[],
): void {
  const label = skel.label as
    | {
        text?: string;
        fontSize?: number;
        fontFamily?: number;
        textAlign?: string;
        verticalAlign?: string;
      }
    | undefined;
  if (!label?.text) return;

  const textId = generateElementId();
  const textEl = newTextElement({
    x: container.x,
    y: container.y,
    text: label.text,
    fontSize: label.fontSize,
    fontFamily: label.fontFamily as Parameters<typeof newTextElement>[0]["fontFamily"],
    textAlign: (label.textAlign ?? "center") as Parameters<typeof newTextElement>[0]["textAlign"],
    verticalAlign: (label.verticalAlign ?? "middle") as Parameters<
      typeof newTextElement
    >[0]["verticalAlign"],
    containerId: container.id,
    id: textId,
  } as Parameters<typeof newTextElement>[0]);

  // Link container to its bound text element
  const existing = (container.boundElements as { id: string; type: string }[] | null) ?? [];
  (container as Record<string, unknown>).boundElements = [
    ...existing,
    { id: textId, type: "text" },
  ];

  const text = textEl as unknown as ExcalidrawElement;
  centerBoundText(text, container);
  results.push(text);
}

const BOUND_TEXT_PADDING = 5;

/**
 * Position a bound text element centered within its container.
 *
 * newTextElement ignores the container's position when computing text coordinates,
 * placing the text center at (0, container.y) instead of the container center.
 * This recomputes x/y using the same formula as excalidraw's internal positioning.
 */
function centerBoundText(text: ExcalidrawElement, container: ExcalidrawElement): void {
  const textAlign = ((text as Record<string, unknown>).textAlign as string) ?? "center";
  const verticalAlign = ((text as Record<string, unknown>).verticalAlign as string) ?? "middle";

  let padX = BOUND_TEXT_PADDING;
  let padY = BOUND_TEXT_PADDING;
  if (container.type === "ellipse") {
    padX += (container.width / 2) * (1 - Math.SQRT2 / 2);
    padY += (container.height / 2) * (1 - Math.SQRT2 / 2);
  } else if (container.type === "diamond") {
    padX += container.width / 4;
    padY += container.height / 4;
  }

  let availW: number;
  let availH: number;
  if (container.type === "ellipse") {
    availW = Math.round((container.width / 2) * Math.SQRT2);
    availH = Math.round((container.height / 2) * Math.SQRT2);
  } else if (container.type === "diamond") {
    availW = container.width / 2 - 2 * BOUND_TEXT_PADDING;
    availH = container.height / 2 - 2 * BOUND_TEXT_PADDING;
  } else {
    availW = container.width - 2 * BOUND_TEXT_PADDING;
    availH = container.height - 2 * BOUND_TEXT_PADDING;
  }

  const el = text as Record<string, unknown>;
  if (textAlign === "left") el.x = container.x + padX;
  else if (textAlign === "right") el.x = container.x + padX + availW - text.width;
  else el.x = container.x + padX + (availW - text.width) / 2;

  if (verticalAlign === "top") el.y = container.y + padY;
  else if (verticalAlign === "bottom") el.y = container.y + padY + availH - text.height;
  else el.y = container.y + padY + (availH - text.height) / 2;
}
