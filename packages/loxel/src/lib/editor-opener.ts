import type * as monaco from "monaco-editor";

import { editorFilePath } from "./live-editor-model";
import { dispatchOpenFile } from "./open-file";

/** Monaco's references controller, which runs the source editor's peek widget. */
const REFERENCES_CONTROLLER_ID = "editor.contrib.referencesController";

interface PeekController {
  closeWidget(focusEditor?: boolean): void;
}

function isPeekController(contribution: unknown): contribution is PeekController {
  return (
    typeof contribution === "object" &&
    contribution !== null &&
    "closeWidget" in contribution &&
    typeof contribution.closeWidget === "function"
  );
}

/**
 * Opens the targets of cross-file navigation (go to definition, a peek widget's picks, document
 * and hover links) in an editor tab. Servers answer with editor model URIs, or `file://` URIs of
 * files outside every project (stdlib, installed packages), which open as external files. Anything
 * else, and a target in the source's own model, is left to Monaco.
 */
export function createEditorOpener(
  openFile: typeof dispatchOpenFile = dispatchOpenFile,
): monaco.editor.ICodeEditorOpener {
  return {
    openCodeEditor(source, resource, selectionOrPosition) {
      const filePath = editorFilePath(resource);
      if (filePath === null) return false;
      // A target in the source's own model is revealed in place by Monaco; this also covers
      // models that are not files on disk, such as the frontmatter editor's.
      if (source.getModel()?.uri.toString() === resource.toString()) return false;

      let line = 1;
      let column = 1;
      if (selectionOrPosition) {
        if ("startLineNumber" in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber;
          column = selectionOrPosition.startColumn;
        } else {
          line = selectionOrPosition.lineNumber;
          column = selectionOrPosition.column;
        }
      }

      // The source's peek widget is done: Monaco would show it again in the source editor, which
      // it takes for the opened one since this opener answers for it.
      const peek = source.getContribution(REFERENCES_CONTROLLER_ID);
      if (isPeekController(peek)) peek.closeWidget(false);

      openFile(filePath, { line, column });
      return true;
    },
  };
}
