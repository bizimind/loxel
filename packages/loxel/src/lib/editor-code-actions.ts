/**
 * Language-server code actions of the focused code editor, as app actions (command palette and
 * remappable keys): each runs Monaco's own command, which asks every server of the file for the
 * kind and applies the only answer or lets the user pick when several servers answer.
 */

import * as monaco from "monaco-editor";

import { isLiveEditorModel } from "./live-editor-model";
import { getAllConnectedLspClients } from "./lsp-client";

/**
 * Each code action command: the Monaco command it runs and the code action kinds it lists (Quick
 * Fix lists refactors too). Monaco runs Fix All and Organize Imports only for a server that
 * declares their kind, hence `declared`.
 */
export const EDITOR_CODE_ACTIONS = {
  "codeAction.quickFix": {
    monacoActionId: "editor.action.quickFix",
    kinds: ["quickfix", "refactor"],
  },
  "codeAction.fixAll": {
    monacoActionId: "editor.action.fixAll",
    kinds: ["source.fixAll"],
    declared: true,
  },
  "codeAction.organizeImports": {
    monacoActionId: "editor.action.organizeImports",
    kinds: ["source.organizeImports"],
    declared: true,
  },
  "codeAction.sourceAction": { monacoActionId: "editor.action.sourceAction", kinds: ["source"] },
  "codeAction.refactor": { monacoActionId: "editor.action.refactor", kinds: ["refactor"] },
} as const;

export type EditorCodeActionId = keyof typeof EDITOR_CODE_ACTIONS;

/** Whether one of the language servers syncing `model` may offer code actions of `kind`. */
function hasCodeActionProvider(
  model: monaco.editor.ITextModel,
  kind: string,
  declared: boolean,
): boolean {
  return getAllConnectedLspClients().some((client) =>
    client.supportsCodeActionKind(model, kind, { declared }),
  );
}

/**
 * The focused Monaco editor, picked as Monaco picks it for its own commands: the one with text
 * focus, else one with widget focus (its find or suggest widget). A peek preview inside an editor
 * tab has the text focus while the tab's editor still has widget focus. Undefined unless the pick
 * shows an editor tab's live model (a peek of a file no tab has open shows a read-only snapshot).
 */
function focusedCodeEditor(): monaco.editor.ICodeEditor | undefined {
  const editors = monaco.editor.getEditors();
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors.find((e) => e.hasWidgetFocus());
  const model = editor?.getModel();
  return model && isLiveEditorModel(model) ? editor : undefined;
}

/**
 * Whether `id` applies in the focused editor: the file is writable and one of its language servers
 * may offer one of its kinds.
 */
export function canRunEditorCodeAction(id: EditorCodeActionId): boolean {
  const editor = focusedCodeEditor();
  const model = editor?.getModel();
  if (!editor || !model || editor.getOption(monaco.editor.EditorOption.readOnly)) return false;
  const action: { kinds: readonly string[]; declared?: boolean } = EDITOR_CODE_ACTIONS[id];
  return action.kinds.some((kind) => hasCodeActionProvider(model, kind, action.declared ?? false));
}

/** Run `id` in the focused editor (the command palette gives focus back to it when it closes). */
export function runEditorCodeAction(id: EditorCodeActionId): void {
  const editor = focusedCodeEditor();
  if (!editor) return;
  editor.focus();
  // `trigger`, not `getAction`: Quick Fix is a command that `getAction` does not list. Bound to
  // ⌘., Quick Fix takes the key from Monaco's paste-options widget, which also binds it.
  editor.trigger("loxel", EDITOR_CODE_ACTIONS[id].monacoActionId, null);
}
