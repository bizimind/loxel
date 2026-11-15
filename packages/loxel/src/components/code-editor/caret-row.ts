import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";

import { useUIStore } from "@/store/ui";

/** Styled in index.css: the light theme's line-highlight color. */
const CARET_ROW_CLASS = "loxel-caret-row";

/**
 * Light shows the caret JetBrains-style: it tints the caret row, gutter included (`trackCaretRow`
 * keeps the row's band while text is selected), and leaves it out of the overview ruler, which
 * keeps to diagnostics and highlights. Dark paints no current-line band at all.
 */
export function caretOptionsFor(darkMode: boolean) {
  return {
    renderLineHighlight: darkMode ? "line" : "all",
    hideCursorInOverviewRuler: !darkMode,
  } satisfies monacoEditor.IEditorOptions;
}

/**
 * Keeps the caret row's band while text is selected, as JetBrains does. Monaco draws its current-line
 * band only for an empty selection (keeping just the gutter tint), so a whole-line decoration on the
 * caret's line takes over while a selection is non-empty, in the line-highlight color and beneath
 * the selection. Light only: dark draws no current-line band, so it sets no decoration.
 */
export function trackCaretRow(editor: monacoEditor.IStandaloneCodeEditor): monaco.IDisposable {
  const band = editor.createDecorationsCollection();
  const update = () => {
    const selection = editor.getSelection();
    if (useUIStore.getState().darkMode || !selection || selection.isEmpty()) {
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
  const unsubscribe = useUIStore.subscribe((state, prev) => {
    if (state.darkMode !== prev.darkMode) update();
  });
  return {
    dispose: () => {
      listener.dispose();
      unsubscribe();
      band.clear();
    },
  };
}
