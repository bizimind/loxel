import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { activeElements, findElementById } from "../elements/element-query.ts";
import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import { loadFile } from "../file/excalidraw-file.ts";

interface LintOptions {
  json?: boolean;
}

interface Warning {
  check: string;
  elementId: string;
  message: string;
}

interface LintResult {
  warnings: Warning[];
  counts: { bindings: number; arrows: number; ids: number; boundingBoxes: number };
  total: number;
}

const CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const EDGE_TOLERANCE = 15;

function shapeEdgeMidpoints(el: ExcalidrawElement): [number, number][] {
  return [
    [el.x + el.width / 2, el.y], // top
    [el.x + el.width / 2, el.y + el.height], // bottom
    [el.x, el.y + el.height / 2], // left
    [el.x + el.width, el.y + el.height / 2], // right
  ];
}

function findShapeNear(
  shapes: ExcalidrawElement[],
  x: number,
  y: number,
): ExcalidrawElement | undefined {
  for (const shape of shapes) {
    for (const [ex, ey] of shapeEdgeMidpoints(shape)) {
      if (Math.abs(ex - x) < EDGE_TOLERANCE && Math.abs(ey - y) < EDGE_TOLERANCE) {
        return shape;
      }
    }
  }
  return undefined;
}

function checkBindings(elements: ExcalidrawElement[]): Warning[] {
  const warnings: Warning[] = [];

  for (const el of elements) {
    const bound = el.boundElements as { type: string; id: string }[] | undefined;
    if (!Array.isArray(bound)) continue;

    for (const binding of bound) {
      if (binding.type !== "text") continue;
      const textEl = findElementById(elements, binding.id);
      if (!textEl) {
        warnings.push({
          check: "binding",
          elementId: el.id,
          message: `Shape references text element "${binding.id}" in boundElements, but that element does not exist`,
        });
      } else if ((textEl.containerId as string | undefined) !== el.id) {
        warnings.push({
          check: "binding",
          elementId: el.id,
          message: `Shape has bound text "${binding.id}", but that text's containerId is "${textEl.containerId ?? "null"}" instead of "${el.id}"`,
        });
      }
    }
  }

  // Check text elements pointing to containers that don't reference them back
  for (const el of elements) {
    if (el.type !== "text") continue;
    const containerId = el.containerId as string | undefined;
    if (!containerId) continue;

    const container = findElementById(elements, containerId);
    if (!container) {
      warnings.push({
        check: "binding",
        elementId: el.id,
        message: `Text has containerId "${containerId}", but that element does not exist`,
      });
      continue;
    }

    const bound = container.boundElements as { type: string; id: string }[] | undefined;
    if (!Array.isArray(bound) || !bound.some((b) => b.id === el.id)) {
      warnings.push({
        check: "binding",
        elementId: el.id,
        message: `Text has containerId "${containerId}", but that container's boundElements does not reference it back`,
      });
    }
  }

  return warnings;
}

function checkArrows(elements: ExcalidrawElement[]): Warning[] {
  const warnings: Warning[] = [];
  const shapes = elements.filter((el) => CONTAINER_TYPES.has(el.type));
  const arrows = elements.filter((el) => el.type === "arrow");

  for (const arrow of arrows) {
    const startBinding = arrow.startBinding as { elementId: string } | null | undefined;
    const endBinding = arrow.endBinding as { elementId: string } | null | undefined;

    // Only check geometric proximity for unbound arrows
    if (!startBinding && !endBinding) {
      const nearStart = findShapeNear(shapes, arrow.x, arrow.y);
      if (!nearStart) {
        warnings.push({
          check: "arrow",
          elementId: arrow.id,
          message: `Arrow start (${Math.round(arrow.x)}, ${Math.round(arrow.y)}) is not near any shape edge`,
        });
      }

      const points = arrow.points as [number, number][] | undefined;
      if (Array.isArray(points) && points.length > 0) {
        const last = points[points.length - 1]!;
        const endX = arrow.x + last[0];
        const endY = arrow.y + last[1];
        const nearEnd = findShapeNear(shapes, endX, endY);
        if (!nearEnd) {
          warnings.push({
            check: "arrow",
            elementId: arrow.id,
            message: `Arrow end (${Math.round(endX)}, ${Math.round(endY)}) is not near any shape edge`,
          });
        }
      }
    }

    // Check binding references exist
    if (startBinding) {
      const target = findElementById(elements, startBinding.elementId);
      if (!target) {
        warnings.push({
          check: "arrow",
          elementId: arrow.id,
          message: `Arrow startBinding references element "${startBinding.elementId}" which does not exist`,
        });
      }
    }
    if (endBinding) {
      const target = findElementById(elements, endBinding.elementId);
      if (!target) {
        warnings.push({
          check: "arrow",
          elementId: arrow.id,
          message: `Arrow endBinding references element "${endBinding.elementId}" which does not exist`,
        });
      }
    }

    // Check elbow properties for multi-point arrows
    const points = arrow.points as [number, number][] | undefined;
    if (Array.isArray(points) && points.length > 2) {
      if (arrow.elbowed !== true) {
        warnings.push({
          check: "arrow",
          elementId: arrow.id,
          message: `Arrow has ${points.length} points but is not marked elbowed — may render as curved instead of 90-degree bends`,
        });
      }
      if (arrow.roundness !== undefined && arrow.roundness !== null) {
        warnings.push({
          check: "arrow",
          elementId: arrow.id,
          message: `Elbowed arrow should have roundness: null, but has roundness set`,
        });
      }
    }
  }

  return warnings;
}

function checkDuplicateIds(elements: ExcalidrawElement[]): Warning[] {
  const seen = new Map<string, number>();
  for (const el of elements) {
    seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  }

  const warnings: Warning[] = [];
  for (const [id, count] of seen) {
    if (count > 1) {
      warnings.push({
        check: "duplicate-id",
        elementId: id,
        message: `ID "${id}" appears ${count} times — elements must have unique IDs`,
      });
    }
  }
  return warnings;
}

function checkBoundingBoxes(elements: ExcalidrawElement[]): Warning[] {
  const warnings: Warning[] = [];
  const arrows = elements.filter((el) => el.type === "arrow");

  for (const arrow of arrows) {
    const points = arrow.points as [number, number][] | undefined;
    if (!Array.isArray(points) || points.length === 0) continue;

    const minX = Math.min(...points.map((p) => p[0]));
    const maxX = Math.max(...points.map((p) => p[0]));
    const minY = Math.min(...points.map((p) => p[1]));
    const maxY = Math.max(...points.map((p) => p[1]));
    const spanX = maxX - minX;
    const spanY = maxY - minY;

    if (arrow.width < spanX - 1) {
      warnings.push({
        check: "bounding-box",
        elementId: arrow.id,
        message: `Arrow width (${Math.round(arrow.width)}) is smaller than point span (${Math.round(spanX)})`,
      });
    }
    if (arrow.height < spanY - 1) {
      warnings.push({
        check: "bounding-box",
        elementId: arrow.id,
        message: `Arrow height (${Math.round(arrow.height)}) is smaller than point span (${Math.round(spanY)})`,
      });
    }
  }

  return warnings;
}

export async function lintCommand(filePath: string, opts: LintOptions): Promise<void> {
  await runAction<LintResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    const elements = activeElements(file.elements);

    const bindingWarnings = checkBindings(elements);
    const arrowWarnings = checkArrows(elements);
    const idWarnings = checkDuplicateIds(elements);
    const bboxWarnings = checkBoundingBoxes(elements);

    const all = [...bindingWarnings, ...arrowWarnings, ...idWarnings, ...bboxWarnings];

    return createResult<LintResult>(
      {
        warnings: all,
        counts: {
          bindings: bindingWarnings.length,
          arrows: arrowWarnings.length,
          ids: idWarnings.length,
          boundingBoxes: bboxWarnings.length,
        },
        total: all.length,
      },
      (r) => {
        if (r.total === 0) return "No potential issues found.";

        const lines: string[] = [];
        lines.push(
          `Found ${r.total} potential issue${r.total === 1 ? "" : "s"} that may need attention:\n`,
        );

        for (const w of r.warnings) {
          lines.push(`  ⚠ [${w.check}] ${w.elementId}: ${w.message}`);
        }

        lines.push("");
        lines.push(
          "These are potential issues — not all may be actual problems. Use 'view' to render",
        );
        lines.push("the diagram and visually verify whether something looks wrong.");
        return lines.join("\n");
      },
    );
  });
}
