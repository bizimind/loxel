import { createResult, runAction } from "@bizimind/cli-common";
import path from "node:path";

import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";

import { cleanupBindings } from "../binding/arrow-binding.ts";
import { STYLE_PROPS } from "../commands/edit.ts";
import { coMoveBoundElements } from "../commands/move.ts";
import { withDom } from "../dom-shim.ts";
import { FONT_FAMILIES, type FontFamilyName } from "../elements/element-defaults.ts";
import {
  buildArrowSkeleton,
  buildContainerSkeleton,
  buildFreeDrawSkeleton,
  buildFrameSkeleton,
  buildLineSkeleton,
  buildTextSkeleton,
  convertSkeletons,
} from "../elements/element-factory.ts";
import { collectCascadeTargets } from "../elements/element-graph.ts";
import { generateElementId, validateIdUnique } from "../elements/element-id.ts";
import { filterByGroupId, findElementByIdOrThrow } from "../elements/element-query.ts";
import { bumpVersion, loadFile, saveFile } from "../file/excalidraw-file.ts";

interface BatchOptions {
  json?: boolean;
}

interface OpResult {
  index: number;
  command: string;
  id?: string;
  textId?: string;
  groupId?: string;
  error?: string;
}

interface BatchResult {
  results: OpResult[];
  total: number;
  succeeded: number;
  failed: number;
}

export async function batchCommand(filePath: string, opts: BatchOptions): Promise<void> {
  await runAction<BatchResult>(opts, async (ctx) => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    const input = await Bun.stdin.text();
    const operations: unknown[] = JSON.parse(input);
    if (!Array.isArray(operations)) throw new Error("Batch input must be a JSON array");

    const results: OpResult[] = [];

    // Collect all draw skeletons first, then convert them all at once
    // This lets skeletonsToElements handle bindings across elements
    const drawSkeletons: Array<{ index: number; skeleton: Record<string, unknown> }> = [];
    const mutationOps: Array<{ index: number; op: Record<string, unknown> }> = [];

    // Phase 1: Parse operations, separate draws from mutations.
    // Back-references for draw ops ($N, $N.text) are resolved eagerly since
    // draw skeletons have real IDs immediately. Mutation ops defer resolution
    // to Phase 3 when all draw results (including label IDs) are available.
    for (let i = 0; i < operations.length; i++) {
      const raw = operations[i];
      if (!raw || typeof raw !== "object") {
        results.push({ index: i, command: "unknown", error: "Each batch entry must be an object" });
        continue;
      }
      const op = raw as Record<string, unknown>;
      const command = typeof op.command === "string" ? op.command : "unknown";

      try {
        if (command === "draw") {
          const resolvedOp = resolveBackReferences(op, results);
          const skeleton = buildDrawSkeleton(resolvedOp);
          const skeletonId = skeleton.id as string;
          // Validate custom ID uniqueness against file + earlier batch skeletons
          if (resolvedOp.id) {
            validateIdUnique(file.elements, skeletonId);
            for (const prev of drawSkeletons) {
              if ((prev.skeleton.id as string) === skeletonId) {
                throw new Error(`Duplicate ID in batch: ${skeletonId}`);
              }
            }
          }
          drawSkeletons.push({ index: i, skeleton });
          results.push({
            index: i,
            command: "draw",
            id: skeletonId,
            // textId populated in Phase 2 after conversion
          });
        } else {
          // Store raw op — back-references resolved in Phase 3
          mutationOps.push({ index: i, op });
          results.push({ index: i, command });
        }
      } catch (err) {
        results.push({
          index: i,
          command,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 2: Convert all draw skeletons at once with proper bindings
    if (drawSkeletons.length > 0) {
      await withDom(async () => {
        const skeletons = drawSkeletons.map((d) => d.skeleton);

        const converted = convertSkeletons(skeletons, file.elements);

        // Update boundElements on existing file elements that arrows bind to
        for (const el of converted) {
          if (el.type !== "arrow") continue;
          const startBinding = el.startBinding as { elementId: string } | null;
          const endBinding = el.endBinding as { elementId: string } | null;
          for (const binding of [startBinding, endBinding]) {
            if (!binding) continue;
            const target =
              file.elements.find((e) => e.id === binding.elementId) ??
              converted.find((e) => e.id === binding.elementId);
            if (target) {
              const bound = (target.boundElements as Array<{ id: string; type: string }>) ?? [];
              if (!bound.some((b) => b.id === el.id)) {
                bound.push({ id: el.id, type: "arrow" });
                target.boundElements = bound;
              }
            }
          }
        }

        // Populate text IDs for draw results (now available after conversion)
        for (const { index, skeleton } of drawSkeletons) {
          const result = results.find((r) => r.index === index);
          if (result && skeleton.label) {
            const container = converted.find((el) => el.id === skeleton.id);
            const bound = (container?.boundElements as Array<{ id: string; type: string }>) ?? [];
            const textBinding = bound.find((b) => b.type === "text");
            if (textBinding) {
              result.textId = textBinding.id;
            }
          }
        }

        file.elements.push(...converted);
      });
    }

    // Phase 3: Apply mutations sequentially, resolving back-references now
    // that all draw results (including label IDs) are available.
    for (const { index, op } of mutationOps) {
      const resultEntry = results.find((r) => r.index === index);
      try {
        const resolvedOp = resolveBackReferences(op, results);
        const result = executeMutation(file.elements, resolvedOp, index);
        if (resultEntry) Object.assign(resultEntry, result);
      } catch (err) {
        if (resultEntry) {
          resultEntry.error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const succeeded = results.filter((r) => !r.error).length;
    if (succeeded > 0) {
      await saveFile(resolved, file);
    }

    const failed = results.filter((r) => r.error).length;
    ctx.log(`Batch complete: ${succeeded} succeeded, ${failed} failed`);

    return createResult<BatchResult>(
      { results, total: operations.length, succeeded, failed },
      (r) => {
        const lines = r.results.map((res) => {
          if (res.error) return `[${res.index}] ${res.command}: ERROR ${res.error}`;
          const ids = [res.id, res.textId, res.groupId].filter(Boolean).join(", ");
          return `[${res.index}] ${res.command}: ${ids}`;
        });
        return lines.join("\n");
      },
    );
  });
}

function buildDrawSkeleton(op: Record<string, unknown>): Record<string, unknown> {
  if (typeof op.type !== "string") throw new Error("'type' (string) is required for draw");
  switch (op.type) {
    case "rect":
    case "rectangle":
      return buildContainerSkeleton("rectangle", op);
    case "ellipse":
      return buildContainerSkeleton("ellipse", op);
    case "diamond":
      return buildContainerSkeleton("diamond", op);
    case "text": {
      if (typeof op.text !== "string") throw new Error("'text' (string) is required for text draw");
      return buildTextSkeleton({ ...op, text: op.text });
    }
    case "line":
      return buildLineSkeleton(op);
    case "arrow":
      return buildArrowSkeleton(op);
    case "freedraw": {
      if (!Array.isArray(op.points)) throw new Error("'points' (array) is required for freedraw");
      return buildFreeDrawSkeleton({ ...op, points: op.points as [number, number][] });
    }
    case "frame":
      return buildFrameSkeleton(op);
    default:
      throw new Error(`Unknown draw type: ${op.type}`);
  }
}

function resolveBackReferences(
  op: Record<string, unknown>,
  results: OpResult[],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(op)) {
    resolved[key] = resolveValue(value, results);
  }
  return resolved;
}

function resolveValue(value: unknown, results: OpResult[]): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolveRef(value, results);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, results));
  }
  return value;
}

function resolveRef(ref: string, results: OpResult[]): string {
  const match = ref.match(/^\$(\d+)(\.text)?$/);
  if (!match) return ref;

  const index = parseInt(match[1]!, 10);
  const isText = !!match[2];

  const result = results[index];
  if (!result) throw new Error(`Back-reference ${ref}: no result at index ${index}`);
  if (result.error) throw new Error(`Back-reference ${ref}: command at index ${index} failed`);

  if (isText) {
    if (!result.textId) throw new Error(`Back-reference ${ref}: no text ID at index ${index}`);
    return result.textId;
  }

  const id = result.id ?? result.groupId;
  if (!id) throw new Error(`Back-reference ${ref}: no ID at index ${index}`);
  return id;
}

function executeMutation(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  if (typeof op.command !== "string") throw new Error("'command' (string) is required");
  const command = op.command;
  switch (command) {
    case "edit":
      return executeEdit(elements, op, index);
    case "move":
      return executeMove(elements, op, index);
    case "resize":
      return executeResize(elements, op, index);
    case "delete":
      return executeDelete(elements, op, index);
    case "group":
      return executeGroup(elements, op, index);
    case "ungroup":
      return executeUngroup(elements, op, index);
    default:
      throw new Error(`Unknown batch command: ${command}`);
  }
}

/** Normalize ids field: accept `ids` array, single `id` string, or throw */
function requireIds(op: Record<string, unknown>): string[] {
  if (Array.isArray(op.ids)) {
    for (const id of op.ids) {
      if (typeof id !== "string") throw new Error("'ids' must be an array of strings");
    }
    return op.ids as string[];
  }
  if (typeof op.id === "string") return [op.id];
  throw new Error("'ids' (array) or 'id' (string) is required");
}

function executeEdit(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  if (typeof op.id !== "string") throw new Error("'id' (string) is required for edit");
  const el = findElementByIdOrThrow(elements, op.id);

  for (const { flag, prop } of STYLE_PROPS) {
    if (op[flag] !== undefined) el[prop] = op[flag];
  }

  if (op.text !== undefined && el.type === "text") {
    el.text = op.text;
    el.originalText = op.text;
  }

  if (op.fontSize !== undefined && el.type === "text") {
    el.fontSize = op.fontSize;
  }

  if (op.fontFamily !== undefined && el.type === "text") {
    el.fontFamily = FONT_FAMILIES[op.fontFamily as FontFamilyName] ?? el.fontFamily;
  }

  if (op.round !== undefined) {
    el.roundness = (op.round as number) > 0 ? { type: 3 } : null;
  }

  bumpVersion(el);
  return { index, command: "edit", id: el.id };
}

function executeMove(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  const ids = requireIds(op);
  const targets: ExcalidrawElement[] = [];

  for (const id of ids) {
    const direct = elements.find((el) => el.id === id && !el.isDeleted);
    if (direct) {
      targets.push(direct);
      continue;
    }
    const grouped = filterByGroupId(elements, id);
    if (grouped.length > 0) {
      targets.push(...grouped);
      continue;
    }
    throw new Error(`Element or group not found: ${id}`);
  }

  let dx: number;
  let dy: number;
  if (typeof op.toX === "number" || typeof op.toY === "number") {
    const first = targets[0]!;
    dx = (typeof op.toX === "number" ? op.toX : first.x) - first.x;
    dy = (typeof op.toY === "number" ? op.toY : first.y) - first.y;
  } else {
    dx = typeof op.dx === "number" ? op.dx : 0;
    dy = typeof op.dy === "number" ? op.dy : 0;
  }

  for (const el of targets) {
    el.x += dx;
    el.y += dy;
    bumpVersion(el);
  }
  coMoveBoundElements(targets, dx, dy, elements);

  return { index, command: "move", id: ids[0] };
}

function executeResize(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  if (typeof op.id !== "string") throw new Error("'id' (string) is required for resize");
  const el = findElementByIdOrThrow(elements, op.id);

  if (typeof op.scale === "number") {
    el.width *= op.scale;
    el.height *= op.scale;
  } else {
    if (typeof op.width === "number") el.width = op.width;
    if (typeof op.height === "number") el.height = op.height;
  }

  bumpVersion(el);
  return { index, command: "resize", id: el.id };
}

function executeDelete(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  const ids = requireIds(op);

  const noCascade = op.cascade === false;
  const cascadeText = !noCascade && op.cascadeText !== false;
  const cascadeArrows = !noCascade && op.cascadeArrows !== false;

  let allIds: string[];
  if (cascadeText || cascadeArrows) {
    allIds = [...collectCascadeTargets(elements, ids, { cascadeText, cascadeArrows })];
  } else {
    allIds = ids;
  }

  for (const id of allIds) {
    const el = elements.find((e) => e.id === id && !e.isDeleted);
    if (!el) continue;
    el.isDeleted = true;
    bumpVersion(el);
    cleanupBindings(elements, id);
  }
  return { index, command: "delete", id: ids[0] };
}

function executeGroup(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  const ids = requireIds(op);
  if (ids.length < 2) throw new Error("At least 2 element IDs required for grouping");
  const groupId = `grp_${generateElementId()}`;

  for (const id of ids) {
    const el = findElementByIdOrThrow(elements, id);
    const groupIds = (el.groupIds as string[]) ?? [];
    groupIds.push(groupId);
    el.groupIds = groupIds;
    bumpVersion(el);
  }

  return { index, command: "group", groupId };
}

function executeUngroup(
  elements: ExcalidrawElement[],
  op: Record<string, unknown>,
  index: number,
): OpResult {
  if (typeof op.groupId !== "string") throw new Error("'groupId' (string) is required for ungroup");
  const groupId = op.groupId;
  const members = filterByGroupId(elements, groupId);
  if (members.length === 0) throw new Error(`Group not found: ${groupId}`);

  for (const el of members) {
    const groupIds = (el.groupIds as string[]) ?? [];
    el.groupIds = groupIds.filter((gid) => gid !== groupId);
    bumpVersion(el);
  }

  return { index, command: "ungroup", groupId };
}
