import type { WebSocketTransport } from "@bizimind/monaco-lsp-client";
import type * as monaco from "monaco-editor";

import {
  DOCUMENT_INDENTATION_METHOD,
  type DocumentIndentationParams,
} from "@/api/lsp-indentation-model";

import { isLiveEditorModel } from "./live-editor-model";

type ModelRegistry = Pick<typeof monaco.editor, "getModels" | "onDidCreateModel">;

/**
 * Send `loxel/documentIndentation` over `transport` for each live editor model of `languageIds`:
 * the models open now, each model created later, and again whenever a model's options change. The
 * model's options are its resolved indentation (see EDITOR.md), so the server bridge can make the
 * language server indent its edits for that file the same way.
 */
export function reportDocumentIndentation(
  transport: Pick<WebSocketTransport, "send">,
  languageIds: readonly string[],
  models: ModelRegistry,
): monaco.IDisposable {
  const languages = new Set(languageIds);
  const watched = new Map<monaco.editor.ITextModel, monaco.IDisposable[]>();

  function report(model: monaco.editor.ITextModel): void {
    if (!isLiveEditorModel(model) || !languages.has(model.getLanguageId())) return;
    const { tabSize, indentSize, insertSpaces } = model.getOptions();
    const params: DocumentIndentationParams = {
      textDocument: { uri: model.uri.toString() },
      indentation: { tabSize, indentSize, insertSpaces },
    };
    // A closed socket drops it; the next connection reports every model again.
    transport.send({ jsonrpc: "2.0", method: DOCUMENT_INDENTATION_METHOD, params }).catch(() => {});
  }

  function watch(model: monaco.editor.ITextModel): void {
    report(model);
    watched.set(model, [
      model.onDidChangeOptions(() => report(model)),
      model.onWillDispose(() => unwatch(model)),
    ]);
  }

  function unwatch(model: monaco.editor.ITextModel): void {
    for (const listener of watched.get(model) ?? []) listener.dispose();
    watched.delete(model);
  }

  for (const model of models.getModels()) watch(model);
  const created = models.onDidCreateModel(watch);

  return {
    dispose() {
      created.dispose();
      for (const model of [...watched.keys()]) unwatch(model);
    },
  };
}
