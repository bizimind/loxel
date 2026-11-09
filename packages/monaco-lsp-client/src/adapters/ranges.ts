import type * as monaco from "monaco-editor";

import type { Range } from "../types";

/** An LSP range (0-based lines and characters) as a Monaco range (1-based). */
export function toMonacoRange(range: Range): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** A Monaco range (1-based lines and columns) as an LSP range (0-based). */
export function toLspRange(range: monaco.IRange): Range {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}
