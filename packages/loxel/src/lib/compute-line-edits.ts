import { diffArrays } from "diff";
import type * as monaco from "monaco-editor";

/**
 * Compute minimal line-level Monaco edit operations to transform a model's content
 * into `newContent`. Uses the `diff` package's `diffArrays` for line-level diffing.
 *
 * Returns `ISingleEditOperation[]` with precise ranges for each changed region.
 * When applied via `model.pushEditOperations()`, Monaco auto-adjusts cursor position
 * based on which ranges shifted — preserving caret position without manual clamping.
 *
 * Returns an empty array if the content is identical (no edits needed).
 */
export function computeLineEdits(
  model: monaco.editor.ITextModel,
  newContent: string,
): monaco.editor.ISingleEditOperation[] {
  const oldContent = model.getValue();
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const changes = diffArrays(oldLines, newLines);
  const edits: monaco.editor.ISingleEditOperation[] = [];

  // 1-based line cursor tracking position in the old (model) content
  let line = 1;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;

    if (!change.added && !change.removed) {
      line += change.count!;
      continue;
    }

    if (change.removed) {
      const startLine = line;
      const removedCount = change.count!;
      line += removedCount;
      const endLine = startLine + removedCount - 1;

      const next = changes[i + 1];
      if (next?.added) {
        // Replacement: swap old lines with new lines
        edits.push({
          range: fullLineRange(model, startLine, endLine),
          text: next.value.join("\n"),
        });
        i++;
      } else {
        // Pure deletion: remove lines including their newline separators
        edits.push({ range: deletionRange(model, startLine, endLine), text: "" });
      }
    } else if (change.added) {
      // Pure insertion (no preceding remove)
      const totalLines = model.getLineCount();
      if (line > totalLines) {
        // Append after last line
        edits.push({
          range: {
            startLineNumber: totalLines,
            startColumn: model.getLineMaxColumn(totalLines),
            endLineNumber: totalLines,
            endColumn: model.getLineMaxColumn(totalLines),
          },
          text: "\n" + change.value.join("\n"),
        });
      } else {
        // Insert before current line
        edits.push({
          range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
          text: change.value.join("\n") + "\n",
        });
      }
    }
  }

  return edits;
}

/**
 * Range covering entire lines [startLine..endLine] content (1-based).
 * From column 1 of startLine to last column of endLine. Used for replacements
 * where the newline structure is preserved by the replacement text.
 */
function fullLineRange(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): monaco.IRange {
  return {
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  };
}

/**
 * Range for deleting lines [startLine..endLine] inclusive (1-based).
 * Extends to consume the adjacent newline separator so no blank lines remain.
 */
function deletionRange(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): monaco.IRange {
  const totalLines = model.getLineCount();
  if (endLine < totalLines) {
    // Delete through start of next line (consumes trailing \n)
    return { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine + 1, endColumn: 1 };
  }
  if (startLine > 1) {
    // Deleting at end of file: consume leading \n from previous line
    return {
      startLineNumber: startLine - 1,
      startColumn: model.getLineMaxColumn(startLine - 1),
      endLineNumber: endLine,
      endColumn: model.getLineMaxColumn(endLine),
    };
  }
  // Deleting all lines
  return {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  };
}
