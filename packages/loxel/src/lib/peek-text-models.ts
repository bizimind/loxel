import * as monaco from "monaco-editor";
import { TextModel } from "monaco-editor/editor/common/model/textModel.js";
import { ITextModelService } from "monaco-editor/editor/common/services/resolverService.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IInstantiationService } from "monaco-editor/platform/instantiation/common/instantiation.js";

import * as api from "@/api/client";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";
import { useWorktreeStore } from "@/store/worktrees";

import { editorFilePath, isPreviewModel, markPreviewModel } from "./live-editor-model";
import { toMonacoLanguage } from "./monaco-theme";
import { resolveLanguage } from "./resolve-language";
import {
  isVirtualDocumentUri,
  VIRTUAL_DOCUMENT_READ_ONLY_MESSAGE,
  virtualDocumentConnection,
} from "./virtual-documents";

export interface PreviewSource {
  /** The content of the file at `path`. */
  readFile(path: string): Promise<string>;
  /** The Monaco language of the file at `path`. */
  languageOf(path: string, content: string): string;
  /** The text and language of a language server's read-only document, while it is connected. */
  readVirtualDocument(uri: string): Promise<{ content: string; language: string }> | null;
}

/**
 * Lets Monaco's peek widgets (Peek Definition, Find References, the `Cmd`-hover definition
 * preview) show editor files (`editorFilePath`) no tab has open. They get their models from the
 * standalone text model service, which only finds registered models and rejects every other URI
 * with "Model not found"; this wraps its `createModelReference`.
 *
 * A file with no registered model gets a read-only snapshot read from `source`: a `TextModel`
 * under the file's URI, so the peek highlights the references in it, that is never registered with
 * Monaco. Nothing that looks models up by URI sees it: a tab opening the file creates its own
 * model, language clients never sync it and workspace edits change the file on disk. It is a
 * preview model (`markPreviewModel`), so `isLiveEditorModel` is false for it and language features
 * stay off in the peek. Every reference reads its own snapshot and disposes it with itself: not
 * every Monaco consumer disposes its reference (the references list can drop one acquired while
 * the peek closes), and a cached snapshot it pinned would show a stale read in every later peek.
 * A language server's read-only document (`virtual-documents.ts`) gets the same kind of snapshot,
 * read from its server. Registered models (open tabs, diff sides) and other URIs go to the service.
 *
 * Returns a disposable that restores the service.
 */
export function installPeekModelResolver(
  source: PreviewSource = previewSource,
): monaco.IDisposable {
  const service = StandaloneServices.get(ITextModelService);
  const instantiation = StandaloneServices.get(IInstantiationService);
  const fallback = service.createModelReference.bind(service);

  service.createModelReference = async (resource) => {
    if (monaco.editor.getModel(resource)) return fallback(resource);
    const path = editorFilePath(resource);
    const reading =
      path === null
        ? source.readVirtualDocument(resource.toString())
        : source
            .readFile(path)
            .then((content) => ({ content, language: source.languageOf(path, content) }));
    if (!reading) return fallback(resource);

    let content: string;
    let language: string;
    try {
      ({ content, language } = await reading);
    } catch (error) {
      throw new Error(`Could not read ${path ?? resource.path} for a preview`, { cause: error });
    }
    const model = instantiation.createInstance(
      TextModel,
      content,
      language,
      TextModel.DEFAULT_CREATION_OPTIONS,
      resource,
    );
    markPreviewModel(model);
    return {
      object: { textEditorModel: model },
      dispose: () => {
        if (!model.isDisposed()) model.dispose();
      },
    };
  };

  return {
    dispose: () => {
      service.createModelReference = fallback;
    },
  };
}

/**
 * Makes `editor` read-only while it shows a preview model, which is a snapshot nothing saves, or a
 * language server's read-only document. Peek widgets show them in their embedded editor, which
 * follows its parent's options otherwise.
 */
export function keepPreviewModelsReadOnly(editor: monaco.editor.ICodeEditor): void {
  let message: string | null = null;
  editor.onDidChangeModel(() => {
    const model = editor.getModel();
    let next: string | null = null;
    if (model && isVirtualDocumentUri(model.uri.toString())) {
      next = VIRTUAL_DOCUMENT_READ_ONLY_MESSAGE;
    } else if (model && isPreviewModel(model)) {
      next = "This is a preview. Open the file to edit it.";
    }
    if (next === message) return;
    message = next;
    editor.updateOptions({ readOnly: next !== null, readOnlyMessage: { value: next ?? "" } });
  });
}

/** Files are read for the active worktree, whose language servers answer the peek. */
const previewSource: PreviewSource = {
  async readFile(path) {
    const worktree = useWorktreeStore.getState().activeWorktreePath;
    return (await api.getFilePreviewContent(path, worktree)).content;
  },
  languageOf(path, content) {
    const associations = selectEffectiveFileAssociations(useSettingsStore.getState());
    return toMonacoLanguage(resolveLanguage(path, associations, content));
  },
  readVirtualDocument(uri) {
    const connection = virtualDocumentConnection(uri);
    return connection
      ? connection
          .read(uri, new monaco.CancellationTokenSource().token)
          .then((content) => ({ content, language: connection.languageId }))
      : null;
  },
};
