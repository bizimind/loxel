import { createResult, runAction } from "@bizimind/cli-common";
import path from "node:path";

import { withDom } from "../dom-shim.ts";
import { buildContainerSkeleton, convertSkeletons } from "../elements/element-factory.ts";
import { loadFile, saveFile } from "../file/excalidraw-file.ts";
import { parseTable } from "../import/table-parser.ts";
import { readStdinText } from "./stdin-ids.ts";

interface ImportTableResult {
  rows: number;
  cols: number;
  elementCount: number;
}

function formatResult(r: ImportTableResult): string {
  return `Imported ${r.rows}x${r.cols} table (${r.elementCount} elements). Cell IDs: r{row}c{col} (e.g., r0c0)`;
}

/** Estimate column widths from text content. */
function computeColumnWidths(
  rows: string[][],
  fixedWidth: number | undefined,
  charWidth: number,
  padding: number,
): number[] {
  if (fixedWidth) return rows[0]!.map(() => fixedWidth);

  const cols = rows[0]!.length;
  const widths: number[] = Array.from({ length: cols }, () => 0);

  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const textWidth = (row[c]?.length ?? 0) * charWidth + padding;
      widths[c] = Math.max(widths[c]!, textWidth, 60); // minimum 60px
    }
  }

  return widths;
}

export async function importTableCommand(
  filePath: string,
  opts: {
    x?: number;
    y?: number;
    cellWidth?: number;
    cellHeight?: number;
    headerBg?: string;
    json?: boolean;
  },
): Promise<void> {
  await runAction<ImportTableResult>(opts, async () => {
    const input = await readStdinText();
    if (!input.trim()) {
      throw new Error("No table data provided on stdin");
    }

    const rows = parseTable(input);
    const numRows = rows.length;
    const numCols = rows[0]!.length;

    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    const cellHeight = opts.cellHeight ?? 40;
    const headerBg = opts.headerBg ?? "#a5d8ff";
    const offsetX = opts.x ?? 0;
    const offsetY = opts.y ?? 0;

    // Estimate column widths (approx 9px per char + 30px padding)
    const colWidths = computeColumnWidths(rows, opts.cellWidth, 9, 30);

    // Build skeletons for all cells
    const skeletons: Record<string, unknown>[] = [];

    for (let r = 0; r < numRows; r++) {
      let xPos = offsetX;
      for (let c = 0; c < numCols; c++) {
        const cellText = rows[r]![c] ?? "";
        const isHeader = r === 0;

        const skeleton = buildContainerSkeleton("rectangle", {
          id: `r${r}c${c}`,
          x: xPos,
          y: offsetY + r * cellHeight,
          width: colWidths[c],
          height: cellHeight,
          text: cellText,
          textFontSize: isHeader ? 16 : 14,
          bg: isHeader ? headerBg : "transparent",
          fill: "solid",
          roughness: 0,
          strokeWidth: 1,
          round: 0,
        });

        skeletons.push(skeleton);
        xPos += colWidths[c]!;
      }
    }

    const converted = await withDom(() => convertSkeletons(skeletons));
    file.elements.push(...converted);
    await saveFile(resolved, file);

    return createResult<ImportTableResult>(
      { rows: numRows, cols: numCols, elementCount: converted.length },
      formatResult,
    );
  });
}
