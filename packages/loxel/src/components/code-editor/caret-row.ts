import * as monaco from "monaco-editor";

/** Styled in index.css: the light theme's line-highlight color, nothing in dark. */
const CARET_ROW_CLASS = "loxel-caret-row";

/**
 * Keeps the caret row's band while text is selected, as JetBrains does. Monaco draws its current-line
 * band only for an empty selection (keeping just the gutter tint), so a whole-line decoration on the
 * caret's line takes over while a selection is non-empty. Its class paints in light mode only (dark
 * draws no current-line band), in the line-highlight color and beneath the selection.
 */
export function trackCaretRow(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const band = editor.createDecorationsCollection();
  const update = () => {
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) {
      band.clear();
      return;
    }
    const line = selection.positionLineNumber;
    band.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: CARET_ROW_CLASS },
      },
    ]);
  };
  update();
  const listener = editor.onDidChangeCursorSelection(update);
  return {
    dispose: () => {
      listener.dispose();
      band.clear();
    },
  };
}
