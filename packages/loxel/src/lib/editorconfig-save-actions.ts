import * as monaco from "monaco-editor";

import type { EditorConfigProperties } from "@/api/editorconfig-model";
import type { SaveReason } from "@/lib/save-editor-content";

type LineSource = Pick<
  monaco.editor.ITextModel,
  "getLineCount" | "getLineContent" | "getLineMaxColumn" | "getEOL"
>;

const TRAILING_WHITESPACE = /[ \t]+$/;

/**
 * Edits that apply `trim_trailing_whitespace` and `insert_final_newline` to a model.
 * `insert_final_newline = false` leaves the end of the file as it is, and an empty file gets no
 * newline. Lines in `keepLines` are not trimmed.
 */
export function editorConfigSaveEdits(
  model: LineSource,
  properties: EditorConfigProperties,
  keepLines: ReadonlySet<number>,
): monaco.editor.ISingleEditOperation[] {
  const edits: monaco.editor.ISingleEditOperation[] = [];
  const lineCount = model.getLineCount();
  let lastLineTrim: monaco.editor.ISingleEditOperation | undefined;
  if (properties.trimTrailingWhitespace) {
    for (let line = 1; line <= lineCount; line++) {
      if (keepLines.has(line)) continue;
      const content = model.getLineContent(line);
      const match = TRAILING_WHITESPACE.exec(content);
      if (!match) continue;
      const edit = {
        range: new monaco.Range(line, match.index + 1, line, content.length + 1),
        text: "",
      };
      edits.push(edit);
      if (line === lineCount) lastLineTrim = edit;
    }
  }
  if (!properties.insertFinalNewline) return edits;
  const lastLine = model.getLineContent(lineCount);
  const lastLineEmpty = lastLineTrim ? lastLineTrim.range.startColumn === 1 : lastLine === "";
  if (lastLineEmpty) return edits;
  // Replacing the trimmed whitespace with the newline keeps the edits from touching each other.
  if (lastLineTrim) lastLineTrim.text = model.getEOL();
  else {
    const column = model.getLineMaxColumn(lineCount);
    edits.push({
      range: new monaco.Range(lineCount, column, lineCount, column),
      text: model.getEOL(),
    });
  }
  return edits;
}

/**
 * Apply `.editorconfig`'s on-save properties to the editor's model before its content is written:
 * trailing whitespace, the final newline, and `end_of_line`. The edits are undoable and keep the
 * cursors where they are. An autosave leaves the whitespace on the cursors' lines alone, since the
 * user may be typing it.
 */
export function applyEditorConfigOnSave(
  editor: Pick<
    monaco.editor.ICodeEditor,
    "getModel" | "getSelections" | "executeEdits" | "pushUndoStop"
  >,
  properties: EditorConfigProperties,
  reason: SaveReason,
): void {
  const model = editor.getModel();
  if (!model) return;
  const selections = editor.getSelections() ?? [];
  const keepLines = new Set(
    reason === "auto" ? selections.map((selection) => selection.positionLineNumber) : [],
  );
  const edits = editorConfigSaveEdits(model, properties, keepLines);
  const eol =
    properties.endOfLine === "crlf"
      ? monaco.editor.EndOfLineSequence.CRLF
      : properties.endOfLine === "lf"
        ? monaco.editor.EndOfLineSequence.LF
        : undefined;
  const convertEol = eol !== undefined && model.getEndOfLineSequence() !== eol;
  if (edits.length === 0 && !convertEol) return;

  // Undo stops on both sides make the save actions their own undo step. Joined to the user's
  // typing, undoing a line-ending change along with it would corrupt the text.
  editor.pushUndoStop();
  if (edits.length > 0) editor.executeEdits("editorconfig", edits, selections);
  if (eol !== undefined && convertEol) model.pushEOL(eol);
  editor.pushUndoStop();
}
