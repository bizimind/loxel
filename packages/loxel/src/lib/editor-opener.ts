import type * as monaco from "monaco-editor";

import { editorFilePath } from "./live-editor-model";
import { dispatchOpenFile } from "./open-file";

/**
 * Opens the targets of cross-file navigation (go to definition, document and hover links) in an
 * editor tab. Servers answer with editor model URIs, or `file://` URIs of files outside every
 * project (stdlib, installed packages), which open as external files. Anything else, and a target
 * in the source's own model, is left to Monaco.
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

      openFile(filePath, { line, column });
      return true;
    },
  };
}
