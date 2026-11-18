import type * as monaco from "monaco-editor";

import { localServerId } from "@/api/local-server";

import { type EditorFile, editorFile } from "./live-editor-model";
import { dispatchOpenFile, dispatchOpenVirtualDocument, type FileLocation } from "./open-file";
import { virtualDocumentConnection } from "./virtual-documents";

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
 * Opens a file of the window's server in an editor tab. Tabs open on the window's server, the only
 * one language servers are reached on (see `createLspClient`), so a file of another is not opened.
 */
function openEditorFile(file: EditorFile, location: FileLocation): void {
  if (file.server !== localServerId()) {
    throw new Error(`${file.path} is on server ${file.server}, which this window cannot open`);
  }
  dispatchOpenFile(file.path, location);
}

/**
 * The file a navigation target names: an editor model URI (see `editorFile`), or a `file:///` URI
 * with no server, such as a link in a server's hover text, which names a file of the server whose
 * model it was shown in.
 */
function targetFile(resource: monaco.Uri, source: monaco.editor.ICodeEditor): EditorFile | null {
  const file = editorFile(resource);
  if (file || resource.scheme !== "file" || resource.authority || resource.query) return file;
  const sourceUri = source.getModel()?.uri;
  const sourceFile = sourceUri ? editorFile(sourceUri) : null;
  return sourceFile ? { server: sourceFile.server, path: resource.path } : null;
}

/**
 * Opens the targets of cross-file navigation (go to definition, a peek widget's picks, document
 * and hover links) in an editor tab. Servers answer with editor model URIs, also for files outside
 * every project (stdlib, installed packages), which open as external files, or URIs of their own
 * read-only documents, which open in a tab of their own while the server is connected. Anything
 * else, and a target in the source's own model, is left to Monaco.
 */
export function createEditorOpener(
  openFile: (file: EditorFile, location: FileLocation) => void = openEditorFile,
  openVirtualDocument: typeof dispatchOpenVirtualDocument = dispatchOpenVirtualDocument,
): monaco.editor.ICodeEditorOpener {
  return {
    openCodeEditor(source, resource, selectionOrPosition) {
      const file = targetFile(resource, source);
      const virtualUri =
        file === null && virtualDocumentConnection(resource.toString())
          ? resource.toString()
          : null;
      if (file === null && virtualUri === null) return false;
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

      if (virtualUri !== null) openVirtualDocument(virtualUri, { line, column });
      else if (file !== null) openFile(file, { line, column });
      return true;
    },
  };
}
