import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import * as monaco from "monaco-editor";
import { ITextModelService } from "monaco-editor/editor/common/services/resolverService.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";

import { isLiveEditorModel, isPreviewModel } from "./live-editor-model";
import { installPeekModelResolver, keepPreviewModelsReadOnly } from "./peek-text-models";

const files = new Map<string, string>([
  ["/repo/a.py", "def a(): ...\n"],
  ["/usr/lib/python3.12/os.py", "import abc\n"],
]);
const readFile = mock(async (path: string) => {
  const content = files.get(path);
  if (content === undefined) throw new Error(`ENOENT ${path}`);
  return content;
});
const installed = installPeekModelResolver({ readFile, languageOf: () => "python" });
const service = StandaloneServices.get(ITextModelService);
const resolve = (uri: string) => service.createModelReference(monaco.Uri.parse(uri));

const disposables: monaco.IDisposable[] = [];

afterEach(() => {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
  readFile.mockClear();
});

afterAll(() => installed.dispose());

describe("installPeekModelResolver", () => {
  test("gives a file no tab has open a read-only snapshot that is never registered", async () => {
    const created = mock();
    disposables.push(monaco.editor.onDidCreateModel(created));

    const ref = await resolve("file:///usr/lib/python3.12/os.py");
    const model = ref.object.textEditorModel;

    expect(model.getValue()).toBe("import abc\n");
    expect(model.getLanguageId()).toBe("python");
    expect(model.uri.toString()).toBe("file:///usr/lib/python3.12/os.py");
    expect(isPreviewModel(model)).toBe(true);
    expect(isLiveEditorModel(model)).toBe(false);
    expect(monaco.editor.getModel(model.uri)).toBeNull();
    expect(created).not.toHaveBeenCalled();
    ref.dispose();
  });

  test("reads each reference its own snapshot, disposed with it", async () => {
    files.set("/repo/c.py", "def c(): ...\n");
    const first = await resolve("loxel://HEAD/repo/c.py");
    files.set("/repo/c.py", "def c(): return 1\n");
    const second = await resolve("loxel://HEAD/repo/c.py");
    const model = first.object.textEditorModel;

    // A reference some consumer never disposes can't pin an old read for later peeks.
    expect(second.object.textEditorModel.getValue()).toBe("def c(): return 1\n");
    expect(model.getValue()).toBe("def c(): ...\n");
    first.dispose();
    first.dispose();
    expect(model.isDisposed()).toBe(true);
    expect(second.object.textEditorModel.isDisposed()).toBe(false);
    second.dispose();
  });

  test("hands out an open tab's own model, which outlives the reference", async () => {
    const tab = monaco.editor.createModel(
      "edited",
      "python",
      monaco.Uri.parse("file:///repo/a.py"),
    );
    disposables.push(tab);

    const ref = await resolve("file:///repo/a.py");

    expect(ref.object.textEditorModel).toBe(tab);
    expect(readFile).not.toHaveBeenCalled();
    ref.dispose();
    expect(tab.isDisposed()).toBe(false);
  });

  test("leaves diff sides and other URIs to Monaco's own service", async () => {
    const side = monaco.editor.createModel(
      "old",
      "python",
      monaco.Uri.parse("loxel://abc/a.py#old"),
    );
    disposables.push(side);

    expect((await resolve("loxel://abc/a.py#old")).object.textEditorModel).toBe(side);
    await expect(resolve("loxel://abc/b.py#old")).rejects.toThrow("Model not found");
    await expect(resolve("inmemory://model/404")).rejects.toThrow("Model not found");
    expect(readFile).not.toHaveBeenCalled();
  });

  test("rejects with the read error and reads again on the next request", async () => {
    const error = await resolve("file:///repo/gone.py").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ cause: new Error("ENOENT /repo/gone.py") });
    files.set("/repo/gone.py", "back\n");
    const ref = await resolve("file:///repo/gone.py");
    expect(ref.object.textEditorModel.getValue()).toBe("back\n");
    expect(readFile).toHaveBeenCalledTimes(2);
    ref.dispose();
  });
});

describe("keepPreviewModelsReadOnly", () => {
  test("makes an editor read-only while it shows a snapshot", async () => {
    const editor = monaco.editor.create(document.createElement("div"));
    const tab = monaco.editor.createModel("x", "python");
    disposables.push(editor, tab);
    keepPreviewModelsReadOnly(editor);
    const ref = await resolve("file:///repo/a.py");
    const readOnly = () => editor.getOption(monaco.editor.EditorOption.readOnly);

    editor.setModel(ref.object.textEditorModel);
    expect(readOnly()).toBe(true);
    editor.setModel(tab);
    expect(readOnly()).toBe(false);
    ref.dispose();
  });
});

describe("Find References", () => {
  // happy-dom has no canvas; the peek widget's editors draw their rulers on one.
  const canvas = new Proxy({}, { get: (_, key) => (key === "canvas" ? undefined : () => ({})) });
  HTMLCanvasElement.prototype.getContext = (() => canvas) as never;

  test("peeks into a file no tab has open, and closing the peek disposes the snapshot", async () => {
    const other = monaco.Uri.parse("file:///repo/a.py");
    const preview = Promise.withResolvers<monaco.editor.ICodeEditor>();
    disposables.push(
      monaco.languages.registerReferenceProvider("python", {
        provideReferences: () => [
          { uri: other, range: new monaco.Range(1, 5, 1, 6) },
          { uri: other, range: new monaco.Range(1, 1, 1, 4) },
        ],
      }),
      monaco.editor.onDidCreateEditor((editor) => {
        keepPreviewModelsReadOnly(editor);
        editor.onDidChangeModel(() => {
          const model = editor.getModel();
          if (model && isPreviewModel(model)) preview.resolve(editor);
        });
      }),
    );
    const source = monaco.editor.createModel("a()\n", "python", monaco.Uri.parse("file:///b.py"));
    const editor = monaco.editor.create(document.createElement("div"), {
      model: source,
      minimap: { enabled: false },
    });
    disposables.push(source);

    editor.trigger("test", "editor.action.goToReferences", null);
    const peek = await preview.promise;
    const snapshot = peek.getModel()!;

    expect(snapshot.getValue()).toBe("def a(): ...\n");
    expect(peek.getOption(monaco.editor.EditorOption.readOnly)).toBe(true);
    const highlighted = snapshot
      .getAllDecorations()
      .filter((d) => d.options.className === "reference-decoration")
      .map((d) => d.range.startColumn);
    expect(highlighted.toSorted((a, b) => a - b)).toEqual([1, 5]);
    // The references tree debounces a refresh to the next task and rejects it, unawaited, when it
    // is disposed first: let it run.
    await new Promise((resolve) => {
      setTimeout(resolve);
    });
    editor.dispose();
    expect(snapshot.isDisposed()).toBe(true);
  });
});
