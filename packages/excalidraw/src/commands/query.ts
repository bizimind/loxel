import path from "node:path";

import { createResult, formatTable, runAction } from "@bizimind/cli-common";

import {
  findByText,
  traverseConnected,
  type TraversalDirection,
} from "../elements/element-graph.ts";
import { activeElements, findElementById } from "../elements/element-query.ts";
import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import { loadFile } from "../file/excalidraw-file.ts";

interface QueryOptions {
  type?: string;
  text?: string;
  connected?: boolean;
  depth?: number;
  direction?: string;
  ids?: boolean;
  json?: boolean;
}

type ElementSummary = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  groupIds: string[];
  depth?: number;
};

interface QueryResult {
  elements: ElementSummary[];
  count: number;
}

function summarize(el: ExcalidrawElement, depth?: number): ElementSummary {
  const text =
    el.type === "text"
      ? String(el.text ?? "").slice(0, 30)
      : el.type === "frame"
        ? ((el.name as string) ?? undefined)
        : undefined;
  return {
    id: el.id,
    type: el.type,
    x: Math.round(el.x),
    y: Math.round(el.y),
    width: Math.round(el.width),
    height: Math.round(el.height),
    text,
    groupIds: (el.groupIds as string[]) ?? [],
    ...(depth !== undefined ? { depth } : {}),
  };
}

export async function queryCommand(
  filePath: string,
  seedIds: string[],
  opts: QueryOptions,
): Promise<void> {
  await runAction<QueryResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    let elements: ExcalidrawElement[];
    let depthMap: Map<string, number> | undefined;

    if (seedIds.length > 0 && opts.connected) {
      // Connected traversal mode
      const direction = (opts.direction ?? "both") as TraversalDirection;
      const maxDepth = opts.depth ?? 1;
      const result = traverseConnected(file.elements, seedIds, { direction, maxDepth });
      if (result.ids.size === 0) {
        throw new Error(`No elements found for IDs: ${seedIds.join(", ")}`);
      }
      elements = [...result.ids]
        .map((id) => findElementById(file.elements, id))
        .filter((el): el is ExcalidrawElement => el !== undefined);
      depthMap = result.depths;
    } else if (seedIds.length > 0) {
      // ID lookup mode
      elements = seedIds
        .map((id) => findElementById(file.elements, id))
        .filter((el): el is ExcalidrawElement => el !== undefined);
      if (elements.length === 0) {
        throw new Error(`No elements found for IDs: ${seedIds.join(", ")}`);
      }
    } else {
      // List mode (no IDs)
      elements = activeElements(file.elements);
    }

    // Apply filters
    if (opts.type) {
      elements = elements.filter((el) => el.type === opts.type);
    }
    if (opts.text) {
      const textMatches = new Set(findByText(file.elements, opts.text).map((el) => el.id));
      elements = elements.filter((el) => textMatches.has(el.id));
    }

    const summaries = elements.map((el) => summarize(el, depthMap?.get(el.id)));

    return createResult<QueryResult>({ elements: summaries, count: summaries.length }, (r) => {
      // --ids: newline-separated IDs for piping
      if (opts.ids) {
        return r.elements.map((e) => e.id).join("\n");
      }

      if (r.count === 0) return "No elements found.";

      type Column = Parameters<typeof formatTable>[1][number];
      const columns: Column[] = [
        { key: "id", label: "ID" },
        { key: "type", label: "Type" },
        { key: "x", label: "X", align: "right" },
        { key: "y", label: "Y", align: "right" },
        {
          key: "width",
          label: "Size",
          align: "right",
          format: (_: unknown, row: Record<string, unknown>) => `${row.width}x${row.height}`,
        },
        { key: "text", label: "Text" },
      ];

      if (depthMap) {
        columns.push({ key: "depth", label: "Depth", align: "right" });
      }

      return formatTable(r.elements, columns);
    });
  });
}
