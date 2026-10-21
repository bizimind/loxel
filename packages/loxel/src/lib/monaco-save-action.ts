import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";

/**
 * Bind Cmd+S in `editor` to `save`. Not `editor.addCommand`: its keybindings go to the keybinding
 * service shared by every editor, unconditionally, so the most recently mounted editor's handler
 * wins everywhere and outlives its editor. An action's keybinding only applies while its own
 * editor has focus, and is removed with the editor.
 */
export function addSaveAction(editor: monacoEditor.IStandaloneCodeEditor, save: () => void): void {
  const action = editor.addAction({
    id: "loxel.save",
    label: "Save",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
    run: save,
  });
  editor.onDidDispose(() => action.dispose());
}
