import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { repositionBoundArrow } from "../elements/element-factory.ts";
import { filterByGroupId, findElementById } from "../elements/element-query.ts";
import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import { bumpVersion, loadFile, saveFile } from "../file/excalidraw-file.ts";

interface MoveOptions {
  dx?: number;
  dy?: number;
  toX?: number;
  toY?: number;
  json?: boolean;
}

interface MoveResult {
  moved: Array<{ id: string; x: number; y: number }>;
}

export async function moveCommand(
  filePath: string,
  ids: string[],
  opts: MoveOptions,
): Promise<void> {
  await runAction<MoveResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    // Resolve IDs: expand group IDs to their member elements
    const elements = resolveTargetElements(file.elements, ids);
    if (elements.length === 0) throw new Error("No elements found for the given IDs");

    let dx: number;
    let dy: number;
    if (opts.toX !== undefined || opts.toY !== undefined) {
      // Absolute positioning: first element to target, others offset
      const first = elements[0]!;
      dx = (opts.toX ?? first.x) - first.x;
      dy = (opts.toY ?? first.y) - first.y;
    } else {
      dx = opts.dx ?? 0;
      dy = opts.dy ?? 0;
      if (dx === 0 && dy === 0) throw new Error("Specify --dx/--dy or --to-x/--to-y");
    }

    for (const el of elements) {
      el.x += dx;
      el.y += dy;
      bumpVersion(el);
    }
    coMoveBoundElements(elements, dx, dy, file.elements);

    await saveFile(resolved, file);

    return createResult<MoveResult>(
      { moved: elements.map((el) => ({ id: el.id, x: Math.round(el.x), y: Math.round(el.y) })) },
      (r) => r.moved.map((m) => `Moved ${m.id} to (${m.x}, ${m.y})`).join("\n"),
    );
  });
}

/**
 * Co-move bound text elements and reposition arrows connected to moved shapes.
 * When a shape with bound text is moved, the text element must follow.
 * When a shape with bound arrows is moved, arrow geometry must be recalculated.
 */
export function coMoveBoundElements(
  movedElements: ExcalidrawElement[],
  dx: number,
  dy: number,
  allElements: readonly ExcalidrawElement[],
): void {
  const movedIds = new Set(movedElements.map((el) => el.id));
  const arrowsToReposition = new Set<ExcalidrawElement>();

  for (const el of movedElements) {
    const bound = el.boundElements as Array<{ id: string; type: string }> | null;
    if (!bound) continue;
    for (const binding of bound) {
      if (binding.type === "text" && !movedIds.has(binding.id)) {
        const textEl = findElementById(allElements, binding.id);
        if (textEl) {
          textEl.x += dx;
          textEl.y += dy;
          bumpVersion(textEl);
          movedIds.add(textEl.id);
        }
      } else if (binding.type === "arrow") {
        const arrowEl = findElementById(allElements, binding.id);
        if (arrowEl) arrowsToReposition.add(arrowEl);
      }
    }
  }

  // Reposition arrows using their fixedPoint bindings and the shapes' new positions
  for (const arrow of arrowsToReposition) {
    if (movedIds.has(arrow.id)) continue;
    repositionBoundArrow(arrow, allElements);
    bumpVersion(arrow);
  }
}

/** Resolve IDs to elements, expanding group IDs */
function resolveTargetElements(
  allElements: ExcalidrawElement[],
  ids: string[],
): ExcalidrawElement[] {
  const result: ExcalidrawElement[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    // Try as element ID first
    const direct = allElements.find((el) => el.id === id && !el.isDeleted);
    if (direct) {
      if (!seen.has(direct.id)) {
        seen.add(direct.id);
        result.push(direct);
      }
      continue;
    }

    // Try as group ID
    const grouped = filterByGroupId(allElements, id);
    if (grouped.length > 0) {
      for (const el of grouped) {
        if (!seen.has(el.id)) {
          seen.add(el.id);
          result.push(el);
        }
      }
      continue;
    }

    throw new Error(`Element or group not found: ${id}`);
  }

  return result;
}
