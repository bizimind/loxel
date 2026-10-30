import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as monaco from "monaco-editor";

/** Code action kinds the fake language servers offer, by model URI. */
const offered = new Map<string, string[]>();
/** Kinds offered without declaring them (a server registered with no kinds), by model URI. */
const undeclared = new Set<string>();
const fakeClient = {
  supportsCodeActionKind: (
    model: monaco.editor.ITextModel,
    kind: string,
    options?: { declared?: boolean },
  ) => {
    const uri = model.uri.toString();
    if (!options?.declared && undeclared.has(uri)) return true;
    return offered.get(uri)?.includes(kind) ?? false;
  },
};
mock.module("./lsp-client", () => ({ getAllConnectedLspClients: () => [fakeClient] }));

const { canRunEditorCodeAction, runEditorCodeAction } = await import("./editor-code-actions");
const { markPreviewModel } = await import("./live-editor-model");

/** `focused`: the editor's text has focus; `widgetFocused`: it or one of its widgets does. */
function fakeEditor(
  uri: string,
  {
    focused = true,
    widgetFocused,
    readOnly = false,
    preview = false,
  }: { focused?: boolean; widgetFocused?: boolean; readOnly?: boolean; preview?: boolean } = {},
) {
  const model = { uri: monaco.Uri.parse(uri) };
  if (preview) markPreviewModel(model);
  const editor = {
    getModel: () => model,
    hasTextFocus: () => focused,
    hasWidgetFocus: () => widgetFocused ?? focused,
    getOption: (option: monaco.editor.EditorOption) =>
      option === monaco.editor.EditorOption.readOnly ? readOnly : undefined,
    focus: mock(() => {}),
    trigger: mock((_source: string, _handlerId: string, _payload: unknown) => {}),
  };
  return { editor, run: editor.trigger };
}

let editors: ReturnType<typeof fakeEditor>["editor"][] = [];

beforeEach(() => {
  editors = [];
  offered.clear();
  undeclared.clear();
  spyOn(monaco.editor, "getEditors").mockImplementation(
    () => editors as unknown as monaco.editor.ICodeEditor[],
  );
});

afterEach(() => {
  mock.restore();
});

describe("editor code actions", () => {
  test("apply in the focused editor tab when one of its servers offers the kind", () => {
    const { editor } = fakeEditor("file:///wt/app.py");
    editors.push(fakeEditor("file:///wt/other.py", { focused: false }).editor, editor);
    offered.set("file:///wt/app.py", ["quickfix", "source.fixAll"]);

    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(true);
    expect(canRunEditorCodeAction("codeAction.fixAll")).toBe(true);
    expect(canRunEditorCodeAction("codeAction.refactor")).toBe(false);
  });

  test("Quick Fix applies where a server offers only refactors, which its menu lists too", () => {
    editors.push(fakeEditor("file:///wt/app.ts").editor);
    offered.set("file:///wt/app.ts", ["refactor"]);
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(true);
  });

  test("do not apply without a focused editor tab, or in a diff side", () => {
    offered.set("file:///wt/app.py", ["quickfix"]);
    offered.set("loxel://HEAD/wt/app.py#new", ["quickfix"]);
    editors.push(fakeEditor("file:///wt/app.py", { focused: false }).editor);
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(false);

    editors.push(fakeEditor("loxel://HEAD/wt/app.py#new").editor);
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(false);
  });

  test("Fix All and Organize Imports need a server that declares their kind", () => {
    editors.push(fakeEditor("file:///wt/app.yaml").editor);
    undeclared.add("file:///wt/app.yaml");
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(true);
    expect(canRunEditorCodeAction("codeAction.fixAll")).toBe(false);
    expect(canRunEditorCodeAction("codeAction.organizeImports")).toBe(false);
  });

  test("in a peek preview, the preview's editor and file, not the tab's", () => {
    // The tab's editor keeps widget focus: the peek is one of its widgets.
    const tab = fakeEditor("file:///wt/app.py", { focused: false, widgetFocused: true });
    const peek = fakeEditor("file:///wt/lib.py");
    editors.push(tab.editor, peek.editor);
    offered.set("file:///wt/app.py", ["source.fixAll"]);
    expect(canRunEditorCodeAction("codeAction.fixAll")).toBe(false);
    offered.set("file:///wt/lib.py", ["source.fixAll"]);
    runEditorCodeAction("codeAction.fixAll");
    expect(peek.run).toHaveBeenCalledTimes(1);
    expect(tab.run).not.toHaveBeenCalled();
  });

  test("in a peek preview's find widget, still the preview", () => {
    const tab = fakeEditor("file:///wt/app.py", { focused: false, widgetFocused: true });
    const peek = fakeEditor("file:///wt/lib.py", { focused: false, widgetFocused: true });
    editors.push(tab.editor, peek.editor);
    offered.set("file:///wt/lib.py", ["source.fixAll"]);
    runEditorCodeAction("codeAction.fixAll");
    expect(peek.run).toHaveBeenCalledTimes(1);
    expect(tab.run).not.toHaveBeenCalled();
  });

  test("a peek of a file no tab has open (a read-only snapshot) gets none", () => {
    const tab = fakeEditor("file:///wt/app.py", { focused: false, widgetFocused: true });
    editors.push(tab.editor, fakeEditor("file:///wt/lib.py", { preview: true }).editor);
    offered.set("file:///wt/app.py", ["quickfix"]);
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(false);
    runEditorCodeAction("codeAction.quickFix");
    expect(tab.run).not.toHaveBeenCalled();
  });

  test("with focus in an editor widget (find, suggest), that editor", () => {
    editors.push(fakeEditor("file:///wt/app.py", { focused: false, widgetFocused: true }).editor);
    offered.set("file:///wt/app.py", ["quickfix"]);
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(true);
  });

  test("do not apply in a read-only editor", () => {
    offered.set("file:///wt/app.py", ["quickfix"]);
    editors.push(fakeEditor("file:///wt/app.py", { readOnly: true }).editor);
    expect(canRunEditorCodeAction("codeAction.quickFix")).toBe(false);
  });

  test("run Monaco's command in the focused editor, focusing it first", () => {
    const other = fakeEditor("file:///wt/other.py", { focused: false });
    const { editor, run } = fakeEditor("file:///wt/app.py");
    editors.push(other.editor, editor);

    runEditorCodeAction("codeAction.organizeImports");

    expect(run.mock.calls).toEqual([["loxel", "editor.action.organizeImports", null]]);
    expect(editor.focus.mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0] ?? 0,
    );
    expect(other.run).not.toHaveBeenCalled();
  });
});
