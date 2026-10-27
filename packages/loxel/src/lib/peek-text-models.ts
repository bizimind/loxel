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

export interface PreviewSource {
  /** The content of the file at `path`. */
  readFile(path: string): Promise<string>;
  /** The Monaco language of the file at `path`. */
  languageOf(path: string, content: string): string;
}

interface Snapshot {
  readonly model: Promise<monaco.editor.ITextModel>;
  /** Set once `model` resolves. */
  loaded?: monaco.editor.ITextModel;
  refs: number;
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
 * stay off in the peek. Holders of the same URI share one snapshot, disposed with the last
 * reference to it. Registered models (open tabs, diff sides) and other URIs go to the service.
 *
 * Returns a disposable that restores the service.
 */
export function installPeekModelResolver(
  source: PreviewSource = previewSource,
): monaco.IDisposable {
  const service = StandaloneServices.get(ITextModelService);
  const instantiation = StandaloneServices.get(IInstantiationService);
  const fallback = service.createModelReference.bind(service);
  const snapshots = new Map<string, Snapshot>();

  const load = async (uri: monaco.Uri, path: string): Promise<monaco.editor.ITextModel> => {
    const content = await source.readFile(path);
    const model = instantiation.createInstance(
      TextModel,
      content,
      source.languageOf(path, content),
      TextModel.DEFAULT_CREATION_OPTIONS,
      uri,
    );
    markPreviewModel(model);
    return model;
  };

  const open = (key: string, uri: monaco.Uri, path: string): Snapshot => {
    const snapshot: Snapshot = {
      model: load(uri, path).then((model) => {
        snapshot.loaded = model;
        return model;
      }),
      refs: 0,
    };
    snapshots.set(key, snapshot);
    return snapshot;
  };

  const release = (key: string, snapshot: Snapshot) => {
    snapshot.refs -= 1;
    if (snapshot.refs > 0) return;
    snapshots.delete(key);
    // Every holder waited for the load, so it has settled.
    snapshot.loaded?.dispose();
  };

  service.createModelReference = async (resource) => {
    const path = editorFilePath(resource);
    if (path === null || monaco.editor.getModel(resource)) return fallback(resource);

    const key = resource.toString();
    const snapshot = snapshots.get(key) ?? open(key, resource, path);
    snapshot.refs += 1;

    let model: monaco.editor.ITextModel;
    try {
      model = await snapshot.model;
    } catch (error) {
      release(key, snapshot);
      throw new Error(`Could not read ${path} for a preview`, { cause: error });
    }
    let disposed = false;
    return {
      object: { textEditorModel: model },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        release(key, snapshot);
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
 * Makes `editor` read-only while it shows a preview model, which is a snapshot nothing saves. Peek
 * widgets show one in their embedded editor, which follows its parent's options otherwise.
 */
export function keepPreviewModelsReadOnly(editor: monaco.editor.ICodeEditor): void {
  let readOnly = false;
  editor.onDidChangeModel(() => {
    const model = editor.getModel();
    const preview = model !== null && isPreviewModel(model);
    if (preview === readOnly) return;
    readOnly = preview;
    editor.updateOptions({
      readOnly,
      readOnlyMessage: { value: "This is a preview. Open the file to edit it." },
    });
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
};
