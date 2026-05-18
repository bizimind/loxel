import { activeElements } from "./element-query.ts";
import type { ExcalidrawElement } from "./excalidraw-types.ts";

export type TraversalDirection = "in" | "out" | "both";

export interface TraversalOptions {
  direction: TraversalDirection;
  maxDepth: number;
}

export interface TraversalResult {
  /** All discovered element IDs (shapes + arrows + bound text) */
  ids: Set<string>;
  /** Map from element ID to depth at which it was discovered */
  depths: Map<string, number>;
}

/**
 * BFS traversal following arrow connections from seed elements.
 *
 * Semantics:
 * - "out": follow arrows where seed is at startBinding (outgoing)
 * - "in": follow arrows where seed is at endBinding (incoming)
 * - "both": follow both directions
 *
 * At each step, when we reach a shape via an arrow, the arrow itself
 * is included in the result set. Bound text elements of any included
 * element are always included.
 */
export function traverseConnected(
  allElements: readonly ExcalidrawElement[],
  seedIds: string[],
  opts: TraversalOptions,
): TraversalResult {
  const active = activeElements(allElements);
  const depths = new Map<string, number>();
  const ids = new Set<string>();

  // Build lookup index
  const byId = new Map<string, ExcalidrawElement>();
  for (const el of active) byId.set(el.id, el);

  // Build arrow connection indices: shapeId → arrows starting/ending at that shape
  const arrowsByStart = new Map<string, ExcalidrawElement[]>();
  const arrowsByEnd = new Map<string, ExcalidrawElement[]>();

  for (const el of active) {
    if (el.type !== "arrow") continue;
    const startBinding = el.startBinding as { elementId: string } | null;
    const endBinding = el.endBinding as { elementId: string } | null;
    if (startBinding) {
      let arr = arrowsByStart.get(startBinding.elementId);
      if (!arr) {
        arr = [];
        arrowsByStart.set(startBinding.elementId, arr);
      }
      arr.push(el);
    }
    if (endBinding) {
      let arr = arrowsByEnd.get(endBinding.elementId);
      if (!arr) {
        arr = [];
        arrowsByEnd.set(endBinding.elementId, arr);
      }
      arr.push(el);
    }
  }

  function addToResult(elemId: string, depth: number): boolean {
    if (ids.has(elemId)) return false;
    ids.add(elemId);
    depths.set(elemId, depth);
    return true;
  }

  // Seed the BFS
  const queue: Array<{ id: string; depth: number }> = [];
  for (const id of seedIds) {
    if (byId.has(id)) {
      addToResult(id, 0);
      queue.push({ id, depth: 0 });
    }
  }

  // BFS
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= opts.maxDepth) continue;

    const el = byId.get(id);
    if (!el) continue;

    // Only traverse from shapes, not from arrows
    if (el.type === "arrow") continue;

    // Outgoing: arrows starting at this shape
    if (opts.direction === "out" || opts.direction === "both") {
      for (const arrow of arrowsByStart.get(id) ?? []) {
        addToResult(arrow.id, depth + 1);
        const endBinding = arrow.endBinding as { elementId: string } | null;
        if (endBinding && addToResult(endBinding.elementId, depth + 1)) {
          queue.push({ id: endBinding.elementId, depth: depth + 1 });
        }
      }
    }

    // Incoming: arrows ending at this shape
    if (opts.direction === "in" || opts.direction === "both") {
      for (const arrow of arrowsByEnd.get(id) ?? []) {
        addToResult(arrow.id, depth + 1);
        const startBinding = arrow.startBinding as { elementId: string } | null;
        if (startBinding && addToResult(startBinding.elementId, depth + 1)) {
          queue.push({ id: startBinding.elementId, depth: depth + 1 });
        }
      }
    }
  }

  // Always include bound text elements for all discovered elements
  const snapshot = [...ids];
  for (const id of snapshot) {
    const el = byId.get(id);
    if (!el) continue;
    const bound = el.boundElements as Array<{ id: string; type: string }> | null;
    if (!bound) continue;
    for (const b of bound) {
      if (b.type === "text") {
        addToResult(b.id, depths.get(id) ?? 0);
      }
    }
  }

  return { ids, depths };
}

/**
 * BFS over boundElements to collect cascade deletion targets.
 * Given a set of primary IDs, finds bound text elements and connected arrows
 * that should be deleted along with the primary elements.
 */
export function collectCascadeTargets(
  elements: readonly ExcalidrawElement[],
  primaryIds: string[],
  opts: { cascadeArrows: boolean; cascadeText: boolean },
): Set<string> {
  const toDelete = new Set<string>(primaryIds);
  const queue = [...primaryIds];

  while (queue.length > 0) {
    const id = queue.pop()!;
    const el = elements.find((e) => e.id === id && !e.isDeleted);
    if (!el) continue;

    const bound = el.boundElements as Array<{ id: string; type: string }> | null;
    if (!bound) continue;

    for (const b of bound) {
      if (toDelete.has(b.id)) continue;
      if (b.type === "text" && opts.cascadeText) {
        toDelete.add(b.id);
        queue.push(b.id);
      } else if (b.type === "arrow" && opts.cascadeArrows) {
        toDelete.add(b.id);
        queue.push(b.id);
      }
    }
  }

  return toDelete;
}

/** Convert a simple glob pattern (supports * and ?) to a case-insensitive regex */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Find elements whose text content matches a glob pattern.
 *
 * Checks:
 * - Text elements (standalone): el.text
 * - Containers with bound text: the bound text element's .text
 * - Frames: el.name
 *
 * Returns the container/shape, not the bound text element itself.
 */
export function findByText(
  allElements: readonly ExcalidrawElement[],
  pattern: string,
): ExcalidrawElement[] {
  const active = activeElements(allElements);
  const regex = globToRegex(pattern);
  const results: ExcalidrawElement[] = [];
  const byId = new Map(active.map((e) => [e.id, e]));

  function matches(text: unknown): boolean {
    return typeof text === "string" && text.length > 0 && regex.test(text);
  }

  for (const el of active) {
    // Skip bound text — match via their container instead
    if (el.type === "text" && el.containerId) continue;

    // Standalone text element
    if (el.type === "text" && matches(el.text)) {
      results.push(el);
      continue;
    }

    // Frame name
    if (el.type === "frame" && matches(el.name)) {
      results.push(el);
      continue;
    }

    // Container with bound text element
    const bound = el.boundElements as Array<{ id: string; type: string }> | null;
    if (bound) {
      for (const b of bound) {
        if (b.type === "text") {
          const textEl = byId.get(b.id);
          if (textEl && matches(textEl.text)) {
            results.push(el);
            break;
          }
        }
      }
    }
  }

  return results;
}
