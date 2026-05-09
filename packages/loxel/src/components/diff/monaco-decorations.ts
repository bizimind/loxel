import type { editor } from "monaco-editor";

import type { ChangeRegion } from "./change-regions";

/**
 * Convert ChangeRegion[] to Monaco editor decorations.
 * Each region gets a whole-line background decoration.
 * No linesDecorationsClassName — the SVG gutter connectors handle the visual link.
 */
export function buildMonacoDecorations(regions: ChangeRegion[]): editor.IModelDeltaDecoration[] {
  return regions.map((region) => {
    const className =
      region.type === "add"
        ? "diff-line-add"
        : region.type === "delete"
          ? "diff-line-del"
          : "diff-line-modify";

    return {
      range: {
        startLineNumber: region.startLine,
        startColumn: 1,
        endLineNumber: region.endLine,
        endColumn: 1,
      },
      options: { isWholeLine: true, className },
    };
  });
}
